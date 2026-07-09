'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the SDK at a local stand-in for api.anthropic.com. This exercises the
// real streaming parser, the real message shapes, and the real tool loop
// without a network call or a live key.
function sse(res, events) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const [event, data] of events) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  res.end();
}

const messageStart = {
  type: 'message_start',
  message: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-8',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 0 },
  },
};

/** Turn 1: say something, then call read_file. Turn 2: report the answer. */
function toolThenAnswer(calls) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      calls.push(parsed);

      if (calls.length === 1) {
        sse(res, [
          ['message_start', messageStart],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking.' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } }],
          ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"note.txt"}' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 1 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }],
          ['message_stop', { type: 'message_stop' }],
        ]);
        return;
      }

      sse(res, [
        ['message_start', messageStart],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'It says hello world.' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } }],
        ['message_stop', { type: 'message_stop' }],
      ]);
    });
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function withAgent(serverFactory, fn) {
  const calls = [];
  const server = serverFactory(calls);
  const port = await listen(server);
  const prev = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;

  // Require after the env var is set so the SDK picks up the base URL.
  delete require.cache[require.resolve('../src/main/harness/agent')];
  const { Agent } = require('../src/main/harness/agent');

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lore-agent-')));
  const agent = new Agent({ apiKey: 'sk-ant-test', root, folderName: path.basename(root) });

  try {
    await fn({ agent, root, calls });
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = prev;
    // Keep-alive sockets would hold the event loop open past the test.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('agent runs a full tool loop: text, tool call, tool result, answer', async () => {
  await withAgent(toolThenAnswer, async ({ agent, root, calls }) => {
    fs.writeFileSync(path.join(root, 'note.txt'), 'hello world');

    const text = [];
    const tools = [];
    const results = [];
    let done = null;

    agent.on('text', (d) => text.push(d));
    agent.on('tool', (t) => tools.push(t));
    agent.on('tool_result', (r) => results.push(r));
    agent.on('done', (d) => (done = d));
    agent.on('error', (e) => assert.fail(`unexpected error: ${e.message}`));

    await agent.send('what does the note say?');

    assert.strictEqual(text.join(''), 'Checking.It says hello world.');
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].name, 'read_file');
    assert.strictEqual(tools[0].label, 'Read note.txt');
    assert.deepStrictEqual(results, [{ id: 'toolu_1', ok: true, output: 'hello world' }]);
    assert.deepStrictEqual(done, { stopReason: 'end_turn' });
  });
});

test('agent sends the tool result back in the shape the API expects', async () => {
  await withAgent(toolThenAnswer, async ({ agent, root, calls }) => {
    fs.writeFileSync(path.join(root, 'note.txt'), 'hello world');
    await agent.send('read the note');

    assert.strictEqual(calls.length, 2, 'one request per turn');

    // Second request carries: user prompt, assistant turn (verbatim), tool_result.
    const second = calls[1];
    assert.strictEqual(second.messages.length, 3);
    assert.strictEqual(second.messages[0].role, 'user');

    const assistant = second.messages[1];
    assert.strictEqual(assistant.role, 'assistant');
    assert.ok(
      assistant.content.some((b) => b.type === 'tool_use' && b.id === 'toolu_1'),
      'the assistant turn must be echoed back verbatim, tool_use blocks included'
    );

    const toolTurn = second.messages[2];
    assert.strictEqual(toolTurn.role, 'user');
    assert.deepStrictEqual(toolTurn.content, [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello world', is_error: false },
    ]);
  });
});

test('agent requests adaptive thinking, high effort, and declares its tools', async () => {
  await withAgent(toolThenAnswer, async ({ agent, root, calls }) => {
    fs.writeFileSync(path.join(root, 'note.txt'), 'hi');
    await agent.send('hi');

    const req = calls[0];
    assert.strictEqual(req.model, 'claude-opus-4-8');
    assert.deepStrictEqual(req.thinking, { type: 'adaptive', display: 'summarized' });
    assert.deepStrictEqual(req.output_config, { effort: 'high' });
    assert.strictEqual(req.stream, true);

    // budget_tokens and sampling params are 400s on Opus 4.8 — never send them.
    assert.strictEqual(req.temperature, undefined);
    assert.strictEqual(req.top_p, undefined);
    assert.strictEqual(req.thinking.budget_tokens, undefined);

    const names = req.tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, [
      'edit_file',
      'list_files',
      'read_file',
      'run_command',
      'write_file',
    ]);
    // The system prompt must never leak the folder's absolute path.
    assert.ok(!req.system.includes('/private/'), 'system prompt leaks an absolute path');
  });
});

test('a failing tool comes back as is_error, and the loop keeps going', async () => {
  await withAgent(toolThenAnswer, async ({ agent, calls }) => {
    // note.txt deliberately does not exist -> read_file fails.
    const results = [];
    agent.on('tool_result', (r) => results.push(r));
    agent.on('error', (e) => assert.fail(`should not surface: ${e.message}`));

    await agent.send('read the note');

    assert.strictEqual(results[0].ok, false);
    const toolTurn = calls[1].messages[2];
    assert.strictEqual(toolTurn.content[0].is_error, true);
  });
});

test('agent surfaces a refusal in plain language', async () => {
  const refuse = () =>
    http.createServer((req, res) => {
      req.resume();
      req.on('end', () =>
        sse(res, [
          ['message_start', messageStart],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 1 } }],
          ['message_stop', { type: 'message_stop' }],
        ])
      );
    });

  await withAgent(refuse, async ({ agent }) => {
    const errors = [];
    agent.on('error', (e) => errors.push(e.message));
    await agent.send('do something disallowed');
    assert.deepStrictEqual(errors, ["I can't help with that."]);
  });
});

test('agent turns an auth failure into advice, not a stack trace', async () => {
  const unauthorized = () =>
    http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      });
    });

  await withAgent(unauthorized, async ({ agent }) => {
    const errors = [];
    agent.on('error', (e) => errors.push(e.message));
    await agent.send('hello');
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /API key was not accepted/);
  });
});
