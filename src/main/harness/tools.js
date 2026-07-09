'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Tool output that lands back in the model's context. Anything larger is
// truncated rather than silently blowing up the conversation.
const MAX_OUTPUT = 20000;
const COMMAND_TIMEOUT_MS = 60_000;

function truncate(text) {
  if (text.length <= MAX_OUTPUT) return text;
  const omitted = text.length - MAX_OUTPUT;
  return `${text.slice(0, MAX_OUTPUT)}\n\n[... ${omitted} more characters omitted ...]`;
}

/**
 * Resolve a model-supplied path against the session's root folder.
 *
 * The path comes from the model, so it is untrusted: `..`, absolute paths, and
 * symlinks that escape the root are all rejected. Everything the agent touches
 * stays inside the folder the user picked.
 */
function resolveInRoot(root, relative) {
  if (typeof relative !== 'string' || relative.length === 0) {
    throw new Error('A path is required.');
  }
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, relative);

  // realpath the deepest part that exists, so a symlink in any parent that
  // points outside the root is caught even when the leaf does not exist yet.
  let probe = target;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) {
    probe = path.dirname(probe);
  }
  const realProbe = fs.realpathSync(probe);
  const suffix = path.relative(probe, target);
  const resolved = path.resolve(realProbe, suffix);

  const rel = path.relative(realRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the session folder: ${relative}`);
  }
  return resolved;
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.venv']);

function listFiles(root, relative = '.') {
  const dir = resolveInRoot(root, relative || '.');
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const lines = entries
    .filter((e) => !e.name.startsWith('.') || e.name === '.env.example')
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  if (lines.length === 0) return '(empty folder)';
  return lines.join('\n');
}

function readFile(root, relative) {
  const file = resolveInRoot(root, relative);
  return truncate(fs.readFileSync(file, 'utf8'));
}

function writeFile(root, relative, content) {
  const file = resolveInRoot(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return `Wrote ${content.length} characters to ${relative}`;
}

function editFile(root, relative, oldStr, newStr) {
  const file = resolveInRoot(root, relative);

  if (oldStr === '') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, newStr);
    return `Created ${relative}`;
  }

  const content = fs.readFileSync(file, 'utf8');
  const first = content.indexOf(oldStr);
  if (first === -1) throw new Error(`Text to replace was not found in ${relative}`);
  if (content.indexOf(oldStr, first + oldStr.length) !== -1) {
    throw new Error(
      `Text to replace appears more than once in ${relative}. Include more surrounding context to make it unique.`
    );
  }
  fs.writeFileSync(file, content.replace(oldStr, newStr));
  return `Edited ${relative}`;
}

function runCommand(root, command) {
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('A command is required.');
  }
  return new Promise((resolve) => {
    execFile(
      '/bin/zsh',
      ['-lc', command],
      { cwd: root, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}`.trim();
        if (err && err.killed) {
          resolve({ ok: false, output: `Command timed out after 60 seconds.\n${out}` });
          return;
        }
        if (err) {
          resolve({ ok: false, output: truncate(out || err.message) });
          return;
        }
        resolve({ ok: true, output: truncate(out || '(no output)') });
      }
    );
  });
}

// Descriptions are prescriptive about *when* to call each tool — recent models
// reach for tools conservatively, and trigger conditions measurably help.
const TOOL_DEFINITIONS = [
  {
    name: 'list_files',
    description:
      'List the files and folders at a path inside the session folder. Call this first when you need to understand what is in the folder before reading or changing anything.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Folder path relative to the session folder. Defaults to the folder root.',
        },
      },
    },
  },
  {
    name: 'read_file',
    description:
      "Read a file's contents. Call this before editing a file, and whenever the answer depends on what a file actually contains rather than what you assume it contains.",
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the session folder.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact snippet of text in a file with new text. Prefer this over write_file for changing part of an existing file. The old text must appear exactly once — include surrounding lines to make it unique. Pass an empty old_text to create a new file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the session folder.' },
        old_text: { type: 'string', description: 'Exact text to replace. Empty string creates the file.' },
        new_text: { type: 'string', description: 'Text to put in its place.' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write a file, replacing it entirely if it exists. Use this for brand-new files or full rewrites; use edit_file to change part of an existing file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the session folder.' },
        content: { type: 'string', description: 'The full contents of the file.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_command',
    description:
      'Run a shell command inside the session folder and return its output. Call this when the task needs something only a real command can do — running tests, installing packages, checking git status, building the project. Commands time out after 60 seconds.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
      },
      required: ['command'],
    },
  },
];

/** Human-readable one-liner for the activity chip in the UI. */
function describeToolCall(name, input) {
  switch (name) {
    case 'list_files':
      return `Looked in ${input.path && input.path !== '.' ? input.path : 'the folder'}`;
    case 'read_file':
      return `Read ${path.basename(input.path || '')}`;
    case 'edit_file':
      return input.old_text === ''
        ? `Created ${path.basename(input.path || '')}`
        : `Edited ${path.basename(input.path || '')}`;
    case 'write_file':
      return `Wrote ${path.basename(input.path || '')}`;
    case 'run_command':
      return `Ran a command`;
    default:
      return name;
  }
}

/** Execute one tool call. Never throws — failures come back as `is_error` text. */
async function executeTool(root, name, input) {
  try {
    switch (name) {
      case 'list_files':
        return { ok: true, output: listFiles(root, input.path) };
      case 'read_file':
        return { ok: true, output: readFile(root, input.path) };
      case 'edit_file':
        return { ok: true, output: editFile(root, input.path, input.old_text, input.new_text) };
      case 'write_file':
        return { ok: true, output: writeFile(root, input.path, input.content) };
      case 'run_command':
        return await runCommand(root, input.command);
      default:
        return { ok: false, output: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, output: err.message };
  }
}

module.exports = {
  TOOL_DEFINITIONS,
  executeTool,
  describeToolCall,
  resolveInRoot,
  truncate,
  MAX_OUTPUT,
};
