/**
 * The dock harness: an in-process agent loop
 * (stream → tool_use → execute → tool_result → repeat).
 *
 * Ported from claude-dock `src/main/harness/agent.js`. Load-bearing details,
 * all asserted by `agent.test.ts`:
 * - The assistant turn (`response.content`, thinking and tool_use blocks
 *   included) must be echoed back verbatim or the next request is rejected.
 * - The system prompt only ever sees the folder's basename, never the
 *   absolute path.
 *
 * The wire call itself lives behind the `ModelTransport` seam (transport.ts):
 * direct Anthropic with a user key by default, or a host-injected transport
 * (the Lore app routes turns through the Lore API).
 */
import { EventEmitter } from 'node:events'

import type Anthropic from '@anthropic-ai/sdk'

import { TOOL_DEFINITIONS, describeToolCall, executeTool, type ToolInput, type ToolResult } from './tools'
import {
  createAnthropicTransport,
  friendlyTransportError,
  type ModelTransport,
} from './transport'

export { MODEL } from './transport'

// Backstop against a runaway tool loop. A real task rarely needs this many
// round trips; hitting it means something is stuck, not that it needs more.
export const MAX_TURNS = 50

/**
 * A tool contributed by the host app rather than the built-in folder toolbox
 * (same optional host-hook pattern as `TranscriptMirror`). Availability is
 * re-read on every model call, so a host capability that comes and goes
 * (e.g. a signed-in session) appears and disappears without recreating the
 * agent. `execute` must never throw — failures come back as `is_error` text.
 */
export interface HostTool {
  definition: Anthropic.Tool
  /** One sentence appended to the system prompt while the tool is offered. */
  promptLine?: string
  isAvailable(): boolean
  /** Human-readable one-liner for the activity chip while the tool runs. */
  describe(input: Record<string, unknown>): string
  /**
   * Optional finished-state label for the activity chip. When present, the UI
   * swaps the running `describe()` text for this once the tool resolves. Tools
   * that omit it keep their running label — additive, so existing tools are
   * unaffected.
   */
  describeDone?(input: Record<string, unknown>): string
  execute(input: Record<string, unknown>): Promise<ToolResult>
}

export function systemPrompt(folderName: string, hostToolLines: string[] = []): string {
  // Host-tool sentences and the tools array are computed together in
  // callModel() so the prompt and the offered tools never disagree.
  const hostLines = hostToolLines.length > 0 ? ` ${hostToolLines.join(' ')}` : ''
  return `You are Lore, a calm and capable assistant working inside a folder on the user's Mac called "${folderName}".

The person you are helping is doing skilled work and knows their own field. Write for them:

- Lead with the outcome. Your first sentence should say what you did or found.
- Be concrete. Name the things you actually mean — files, paths, symbols, commands, documents, people, dates — and show code, a diff, or the source text when that is the answer. Use the vocabulary of their work, and never trade precision for vagueness.
- Do not make them learn how you work. Talk about their system, not about turns, context, or tools.
- Match length to the question. A quick lookup deserves a quick answer; a request to orient in a domain or assess a system earns as much space as its coverage needs. Use a header, a list, or a table when the answer is genuinely structured, not by default.
- A request to understand a domain or a system owes three things: its vocabulary, the dimensions along which it can be judged, and what the user does not yet know to ask about.
- Name what you read. Say when you are speaking from general knowledge about comparable systems rather than what is in front of you, and close a substantial assessment with what you did not inspect.
- Never narrate what you are about to do ("Let me check...", "Now I'll..."). The interface already shows your activity. Just do the work and report the result.
- If you cannot do something, say so plainly and say what you would need.

When the user asks you to derive a work program from an assessment or findings, write the work program to a Markdown Output and call show_artifact to show it; do not answer only in the conversation.

Order items by priority. Give each item a stable, document-local ID in the form WP-<three decimal digits>, starting with WP-001. Each item must use its ID in the heading and include these six labeled sections:

- **Problem**
- **Source finding / evidence**
- **Intended outcome**
- **Priority rationale**
- **Dependencies / risks**
- **Completion test**

Preserve the assessment finding or reviewable evidence in **Source finding / evidence**. If support is missing, state the evidence gap rather than inventing support. End every item with an action link whose ID matches its heading, exactly in this form: [Implement this item](workbench:implement?item=WP-001).

A later request to implement a selected item will identify the current Markdown Output by its path and the selected item by its item ID. Interpret those values from that request, read the identified item from that Output before acting, and use all six sections as the implementation brief.

When you make something the user will look at or read, show it: call show_artifact after writing the file so it appears beside the conversation. Documents, plans, and notes are markdown files; anything interactive or designed — a dashboard, a chart, a game, a poster, a page — is a single self-contained HTML file (all styles and scripts inline, no external links or network requests). Keep improving the same file when they ask for changes; the pane refreshes automatically.

When you create or update an Output, include provenance metadata in show_artifact:
- Do not list Evidence; the system derives Evidence lineage from the work that produced the file.
- Provide concise inferences and uncertainties arrays. Include only interpretations and limitations that materially affect how the Output should be read.
- When synthesizing recommendations from existing Outputs in this project, add derived_from entries that reference their relative paths and, when available, the finding labels you relied on.

You have tools to look at, change, and create files in the folder, and to run commands. Use them rather than guessing — read a file before you change it, using read_file rather than a shell command when you only need its contents.${hostLines} When you have enough information to act, act; do not ask permission for reversible steps that clearly follow from the request. Before proposing an approval-gated shell action, use a safe alternative when one can complete the request. An Approval applies only to the exact refused action, not the whole task. Ask first before deleting anything or doing something hard to undo.`
}

export interface AgentOptions {
  /** Direct-Anthropic key (BYOK). Ignored when `transport` is provided. */
  apiKey?: string
  /** Host-injected model transport; defaults to direct Anthropic via `apiKey`. */
  transport?: ModelTransport
  root: string
  folderName: string
  /** Optional host hook: extra tools contributed by the host app (see `HostTool`). */
  hostTools?: HostTool[]
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
  /** Optional finished-state chip label from a host tool's `describeDone`. */
  doneLabel?: string
}

export interface AgentDoneEvent {
  stopReason: string | null
}

export interface AgentErrorEvent {
  message: string
}

export class Agent extends EventEmitter {
  private transport: ModelTransport
  private root: string
  private folderName: string
  private hostTools: HostTool[]
  /**
   * The running conversation. Assistant turns are stored verbatim
   * (`response.content` unmodified) — see module docblock.
   */
  messages: Anthropic.MessageParam[] = []
  running = false
  private aborted = false
  private turnAbort: AbortController | null = null

  constructor({ apiKey, transport, root, folderName, hostTools }: AgentOptions) {
    super()
    if (!transport && !apiKey) throw new Error('Agent needs a transport or an apiKey.')
    this.transport = transport ?? createAnthropicTransport(apiKey as string)
    this.root = root
    this.folderName = folderName
    this.hostTools = hostTools ?? []
  }

  abort(): void {
    this.aborted = true
    this.turnAbort?.abort()
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
          const rawInput = (call.input || {}) as Record<string, unknown>
          const input = rawInput as ToolInput
          // Dispatch against all registered host tools, not just the ones
          // offered this turn: if availability flipped mid-turn, the tool's
          // own execute() reports the failure in words instead of the model
          // hitting an opaque unknown-tool error.
          const hostTool = this.hostTools.find((t) => t.definition.name === call.name)
          this.emit('tool', {
            id: call.id,
            name: call.name,
            label: hostTool ? hostTool.describe(rawInput) : describeToolCall(call.name, input),
            input: call.input,
          } satisfies AgentToolEvent)

          const { ok, output } = hostTool
            ? await hostTool.execute(rawInput)
            : await executeTool(this.root, call.name, input)

          const doneLabel = hostTool?.describeDone?.(rawInput)
          this.emit('tool_result', {
            id: call.id,
            ok,
            output,
            ...(doneLabel ? { doneLabel } : {}),
          } satisfies AgentToolResultEvent)
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
      else this.emit('error', { message: friendlyTransportError(err) } satisfies AgentErrorEvent)
    } finally {
      this.running = false
      this.turnAbort = null
    }
  }

  private async callModel(): Promise<Anthropic.Message> {
    // Re-read host-tool availability every call so a capability that came or
    // went mid-conversation (e.g. signing in) is reflected on the next turn.
    const active = this.hostTools.filter((t) => t.isAvailable())
    const controller = new AbortController()
    this.turnAbort = controller
    if (this.aborted) controller.abort()

    return this.transport.streamTurn(
      {
        system: systemPrompt(
          this.folderName,
          active.map((t) => t.promptLine).filter((line): line is string => Boolean(line)),
        ),
        tools:
          active.length > 0
            ? [...TOOL_DEFINITIONS, ...active.map((t) => t.definition)]
            : TOOL_DEFINITIONS,
        messages: this.messages,
      },
      {
        onText: (delta) => this.emit('text', delta),
        onThinking: (delta) => this.emit('thinking', delta),
      },
      controller.signal,
    )
  }
}
