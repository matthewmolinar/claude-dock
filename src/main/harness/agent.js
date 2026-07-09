'use strict';

const { EventEmitter } = require('events');
const AnthropicModule = require('@anthropic-ai/sdk');

const Anthropic = AnthropicModule.default || AnthropicModule;
const { TOOL_DEFINITIONS, executeTool, describeToolCall } = require('./tools');

const MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 32000;

// Backstop against a runaway tool loop. A real task rarely needs this many
// round trips; hitting it means something is stuck, not that it needs more.
const MAX_TURNS = 50;

function systemPrompt(folderName) {
  return `You are Lore, a calm and capable assistant working inside a folder on the user's Mac called "${folderName}".

The person you are helping is not a programmer. Write for them:

- Lead with the outcome. Your first sentence should say what you did or found.
- Use plain language. Never show raw commands, file paths, code, or jargon unless they ask.
- Be brief. Two or three sentences is usually right. No headers, no bullet lists unless the answer is genuinely a list.
- Never narrate what you are about to do ("Let me check...", "Now I'll..."). The interface already shows your activity. Just do the work and report the result.
- If you cannot do something, say so plainly and say what you would need.

You have tools to look at, change, and create files in the folder, and to run commands. Use them rather than guessing — read a file before you change it. When you have enough information to act, act; do not ask permission for reversible steps that clearly follow from the request. Ask first before deleting anything or doing something hard to undo.`;
}

class Agent extends EventEmitter {
  constructor({ apiKey, root, folderName }) {
    super();
    this.client = new Anthropic({ apiKey });
    this.root = root;
    this.system = systemPrompt(folderName);
    this.messages = [];
    this.running = false;
    this.aborted = false;
    this.stream = null;
  }

  abort() {
    this.aborted = true;
    if (this.stream) this.stream.abort();
  }

  /**
   * Run one user turn to completion, looping through tool calls.
   * Emits: text, thinking, tool, tool_result, done, error.
   */
  async send(prompt) {
    if (this.running) throw new Error('Already working.');
    this.running = true;
    this.aborted = false;

    this.messages.push({ role: 'user', content: prompt });

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        if (this.aborted) {
          this.emit('done', { stopReason: 'aborted' });
          return;
        }

        const response = await this._callModel();

        if (response.stop_reason === 'refusal') {
          this.emit('error', { message: "I can't help with that." });
          return;
        }

        // Preserve the assistant turn verbatim — thinking and tool_use blocks
        // must go back unmodified or the next request is rejected.
        this.messages.push({ role: 'assistant', content: response.content });

        if (response.stop_reason === 'pause_turn') continue;

        const toolUses = response.content.filter((b) => b.type === 'tool_use');
        if (toolUses.length === 0) {
          this.emit('done', { stopReason: response.stop_reason });
          return;
        }

        // All results for one assistant turn go back in a single user message.
        const results = [];
        for (const call of toolUses) {
          this.emit('tool', {
            id: call.id,
            name: call.name,
            label: describeToolCall(call.name, call.input || {}),
            input: call.input,
          });

          const { ok, output } = await executeTool(this.root, call.name, call.input || {});

          this.emit('tool_result', { id: call.id, ok, output });
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: output,
            is_error: !ok,
          });
        }
        this.messages.push({ role: 'user', content: results });
      }

      this.emit('error', {
        message: 'I got stuck going back and forth. Try asking in a smaller step.',
      });
    } catch (err) {
      if (this.aborted) this.emit('done', { stopReason: 'aborted' });
      else this.emit('error', { message: friendlyError(err) });
    } finally {
      this.running = false;
      this.stream = null;
    }
  }

  async _callModel() {
    const stream = this.client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: this.system,
      // Adaptive thinking with a summary so the UI can show honest progress
      // instead of a blank pause while the model reasons.
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
      tools: TOOL_DEFINITIONS,
      messages: this.messages,
    });
    this.stream = stream;

    stream.on('text', (delta) => this.emit('text', delta));
    stream.on('thinking', (delta) => this.emit('thinking', delta));
    // An EventEmitter with no 'error' listener rethrows. finalMessage() already
    // surfaces the failure, so swallow it here and let the caller's catch run.
    stream.on('error', () => {});

    if (this.aborted) stream.abort();
    return stream.finalMessage();
  }
}

function friendlyError(err) {
  const A = Anthropic;
  if (err instanceof A.AuthenticationError) {
    return 'That API key was not accepted. Add a valid key in Settings.';
  }
  if (err instanceof A.RateLimitError) {
    return 'Anthropic is rate limiting this key. Wait a moment and try again.';
  }
  if (err instanceof A.APIConnectionError) {
    return 'I could not reach Anthropic. Check your internet connection.';
  }
  if (err instanceof A.APIError) {
    return `Anthropic returned an error: ${err.message}`;
  }
  return err.message || 'Something went wrong.';
}

module.exports = { Agent, MODEL, MAX_TURNS, systemPrompt };
