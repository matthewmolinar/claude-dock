/**
 * The dock harness: an in-process agent loop against the Anthropic API
 * (stream → tool_use → execute → tool_result → repeat).
 *
 * Ported from claude-dock `src/main/harness/agent.js`. Load-bearing details,
 * all asserted by `agent.test.ts`:
 * - Opus 4.8 rejects `budget_tokens`, `temperature`, `top_p`, `top_k` with a
 *   400. Use `thinking: {type:'adaptive'}` + `output_config.effort` instead.
 * - The assistant turn (`response.content`, thinking and tool_use blocks
 *   included) must be echoed back verbatim or the next request is rejected.
 * - The system prompt only ever sees the folder's basename, never the
 *   absolute path.
 */
import { EventEmitter } from 'node:events'

import Anthropic from '@anthropic-ai/sdk'

import { TOOL_DEFINITIONS, describeToolCall, executeTool, type ConfirmCommand, type ToolInput } from './tools'

export const MODEL = 'claude-opus-4-8'
const MAX_TOKENS = 32000

// Backstop against a runaway tool loop. A real task rarely needs this many
// round trips; hitting it means something is stuck, not that it needs more.
export const MAX_TURNS = 50

export function systemPrompt(folderName: string): string {
  return `You are Lore, a calm and capable assistant working inside a folder on the user's Mac called "${folderName}".

The person you are helping is not a programmer. Write for them:

- Lead with the outcome. Your first sentence should say what you did or found.
- Use plain language. Never show raw commands, file paths, code, or jargon unless they ask.
- Be brief. Two or three sentences is usually right. No headers, no bullet lists unless the answer is genuinely a list.
- Never narrate what you are about to do ("Let me check...", "Now I'll..."). The interface already shows your activity. Just do the work and report the result.
- If you cannot do something, say so plainly and say what you would need.

When you make something the user will look at or read, show it: call show_artifact after writing the file so it appears beside the conversation. Documents, plans, and notes are markdown files; anything interactive or designed — a dashboard, a chart, a game, a poster, a page — is a single self-contained HTML file (all styles and scripts inline, no external links or network requests). Keep improving the same file when they ask for changes; the pane refreshes automatically.

You have tools to look at, change, and create files in the folder, and to run commands. Use them rather than guessing — read a file before you change it. When you have enough information to act, act; do not ask permission for reversible steps that clearly follow from the request. Ask first before deleting anything or doing something hard to undo.`
}

export interface AgentOptions {
  apiKey: string
  root: string
  folderName: string
  /** Gate for `run_command`. Omitted means every command is declined. */
  confirmCommand?: ConfirmCommand
}

export interface AgentToolEvent {
  id: string
  name: string
  label: string
  input: unknown
}

export interface AgentToolResultEvent {
  id: string
  ok: boolean
  output: string
}

export interface AgentDoneEvent {
  stopReason: string | null
}

export interface AgentErrorEvent {
  message: string
}

export class Agent extends EventEmitter {
  private client: Anthropic
  private root: string
  private system: string
  private confirmCommand?: ConfirmCommand
  /**
   * The running conversation. Assistant turns are stored verbatim
   * (`response.content` unmodified) — see module docblock.
   */
  messages: Anthropic.MessageParam[] = []
  running = false
  private aborted = false
  private stream: { abort(): void } | null = null

  constructor({ apiKey, root, folderName, confirmCommand }: AgentOptions) {
    super()
    this.client = new Anthropic({ apiKey })
    this.root = root
    this.system = systemPrompt(folderName)
    this.confirmCommand = confirmCommand
  }

  abort(): void {
    this.aborted = true
    if (this.stream) this.stream.abort()
  }

  /**
   * Run one user turn to completion, looping through tool calls.
   * Emits: text, thinking, tool, tool_result, done, error.
   */
  async send(prompt: string): Promise<void> {
    if (this.running) throw new Error('Already working.')
    this.running = true
    this.aborted = false

    this.messages.push({ role: 'user', content: prompt })

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        if (this.aborted) {
          this.emit('done', { stopReason: 'aborted' } satisfies AgentDoneEvent)
          return
        }

        const response = await this.callModel()

        if (response.stop_reason === 'refusal') {
          this.emit('error', { message: "I can't help with that." } satisfies AgentErrorEvent)
          return
        }

        // Preserve the assistant turn verbatim — thinking and tool_use blocks
        // must go back unmodified or the next request is rejected.
        this.messages.push({ role: 'assistant', content: response.content })
        // The verbatim block array is also what the Lore transcript mirror
        // writes to disk (it is exactly Claude Code's on-disk shape).
        this.emit('assistant_message', response.content)

        if (response.stop_reason === 'pause_turn') continue

        const toolUses = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        )
        if (toolUses.length === 0) {
          this.emit('done', { stopReason: response.stop_reason } satisfies AgentDoneEvent)
          return
        }

        // All results for one assistant turn go back in a single user message.
        const results: Anthropic.ToolResultBlockParam[] = []
        for (const call of toolUses) {
          const input = (call.input || {}) as ToolInput
          this.emit('tool', {
            id: call.id,
            name: call.name,
            label: describeToolCall(call.name, input),
            input: call.input,
          } satisfies AgentToolEvent)

          const { ok, output } = await executeTool(this.root, call.name, input, this.confirmCommand)

          this.emit('tool_result', { id: call.id, ok, output } satisfies AgentToolResultEvent)
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: output,
            is_error: !ok,
          })
        }
        this.messages.push({ role: 'user', content: results })
        this.emit('tool_results_message', results)
      }

      this.emit('error', {
        message: 'I got stuck going back and forth. Try asking in a smaller step.',
      } satisfies AgentErrorEvent)
    } catch (err) {
      if (this.aborted) this.emit('done', { stopReason: 'aborted' } satisfies AgentDoneEvent)
      else this.emit('error', { message: friendlyError(err) } satisfies AgentErrorEvent)
    } finally {
      this.running = false
      this.stream = null
    }
  }

  private async callModel(): Promise<Anthropic.Message> {
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
    })
    this.stream = stream

    stream.on('text', (delta) => this.emit('text', delta))
    stream.on('thinking', (delta) => this.emit('thinking', delta))
    // An EventEmitter with no 'error' listener rethrows. finalMessage() already
    // surfaces the failure, so swallow it here and let the caller's catch run.
    stream.on('error', () => {})

    if (this.aborted) stream.abort()
    return stream.finalMessage()
  }
}

function friendlyError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'That API key was not accepted. Add a valid key in Settings.'
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Anthropic is rate limiting this key. Wait a moment and try again.'
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'I could not reach Anthropic. Check your internet connection.'
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic returned an error: ${err.message}`
  }
  return err instanceof Error ? err.message : 'Something went wrong.'
}
