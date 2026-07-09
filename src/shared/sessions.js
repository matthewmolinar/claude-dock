'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Claude Code keeps a per-project session index at
 *   ~/.claude/projects/<cwd with "/" replaced by "-">/sessions-index.json
 * Each entry carries a model-written `summary`, which makes a far better slot
 * label than the raw first prompt.
 */
function claudeIndexPath(cwd, home = os.homedir()) {
  const escaped = cwd.replace(/\//g, '-');
  return path.join(home, '.claude', 'projects', escaped, 'sessions-index.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Newest entry by fileMtime, or null. */
function newestEntry(index) {
  if (!index || !Array.isArray(index.entries) || index.entries.length === 0) {
    return null;
  }
  return index.entries.reduce((best, e) =>
    !best || (e.fileMtime || 0) > (best.fileMtime || 0) ? e : best
  , null);
}

/**
 * Best-effort human label for the most recent agent session rooted at `cwd`.
 * Returns null when nothing useful is on disk — never throws.
 */
function getRecentSessionSummary(cwd, agentKey, home = os.homedir()) {
  if (!cwd || typeof cwd !== 'string') return null;

  if (agentKey === 'claude') {
    const entry = newestEntry(readJson(claudeIndexPath(cwd, home)));
    if (!entry) return null;
    const label = entry.summary || entry.firstPrompt;
    return label && label.length > 0 ? label : null;
  }

  if (agentKey === 'codex') {
    return newestCodexPrompt(home);
  }

  return null;
}

/** Codex writes JSONL transcripts under ~/.codex/sessions/YYYY/MM/DD/. */
function newestCodexPrompt(home = os.homedir()) {
  const root = path.join(home, '.codex', 'sessions');
  let newest = null;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.name.endsWith('.jsonl')) {
        let mtime;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {
          continue;
        }
        if (!newest || mtime > newest.mtime) newest = { file: full, mtime };
      }
    }
  };
  walk(root, 0);
  if (!newest) return null;

  let content;
  try {
    content = fs.readFileSync(newest.file, 'utf8');
  } catch {
    return null;
  }
  for (const line of content.split('\n')) {
    if (!line.includes('"user_message"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = obj && (obj.message || (obj.payload && obj.payload.message));
    if (typeof msg === 'string' && msg.length > 0 && !msg.startsWith('<environment_context>')) {
      return msg;
    }
  }
  return null;
}

module.exports = { getRecentSessionSummary, claudeIndexPath, newestEntry };
