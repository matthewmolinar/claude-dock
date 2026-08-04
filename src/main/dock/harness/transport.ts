/**
 * The model transport seam: how the agent loop reaches a Claude model.
 *
 * The agent composes the turn (system prompt, tools, verbatim message
 * history) and owns the tool loop; the transport owns the wire. Two
 * implementations exist:
 * - `createAnthropicTransport` (here): direct Anthropic API with a
 *   user-supplied key — the default, and the only transport in the OSS app.
 * - The Lore desktop app injects a server transport that runs the same turn
 *   through the Lore API on the team's metered inference (outside this
 *   OSS-synced subtree).
 *
 * The wire contract is the Anthropic message shape either way; the server
 * transport's backend model is the Lore API's choice (it translates this
 * shape onto its own provider) — the harness behaves identically.
 */
import Anthropic from '@anthropic-ai/sdk'

export const MODEL = 'claude-opus-4-8'
export const MAX_TOKENS = 32000

/** One model turn: everything the wire call needs, already composed. */
export interface ModelTurnRequest {
  system: string
  tools: Anthropic.Tool[]
  messages: Anthropic.MessageParam[]
}

export interface ModelTurnHandlers {
  onText(delta: string): void
  onThinking(delta: string): void
}

export interface ModelTransport {
  /**
   * Stream one turn to completion. Resolves with the final message with
   * content blocks verbatim (thinking and tool_use included — the agent
   * echoes them back next turn). Must reject promptly when `signal` aborts.
   */
  streamTurn(
    req: ModelTurnRequest,
    handlers: ModelTurnHandlers,
    signal: AbortSignal,
  ): Promise<Anthropic.Message>
}

/**
 * The direct-Anthropic transport (bring-your-own-key). Opus 4.8 rejects
 * `budget_tokens`, `temperature`, `top_p`, `top_k` with a 400 — adaptive
 * thinking + output_config.effort only (asserted by agent.test.ts).
 */
export function createAnthropicTransport(apiKey: string): ModelTransport {
  const client = new Anthropic({ apiKey })
  return {
    async streamTurn(req, handlers, signal) {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: req.system,
        // Adaptive thinking with a summary so the UI can show honest
        // progress instead of a blank pause while the model reasons.
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'high' },
        tools: req.tools,
        messages: req.messages,
      })

      stream.on('text', (delta) => handlers.onText(delta))
      stream.on('thinking', (delta) => handlers.onThinking(delta))
      // An EventEmitter with no 'error' listener rethrows. finalMessage()
      // already surfaces the failure, so swallow it here.
      stream.on('error', () => {})

      const onAbort = () => stream.abort()
      if (signal.aborted) stream.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
      try {
        return await stream.finalMessage()
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    },
  }
}

/**
 * Map a transport failure to copy a non-technical dock user can act on.
 * Direct-Anthropic failures resolve here; a host-injected transport can
 * throw `TransportError` to carry its own copy through unchanged.
 */
export class TransportError extends Error {
  constructor(
    message: string,
    /** Stable machine code, e.g. 'credits_exhausted' | 'not_signed_in'. */
    public readonly code?: string,
  ) {
    super(message)
    this.name = 'TransportError'
  }
}

export function friendlyTransportError(err: unknown): string {
  if (err instanceof TransportError) return err.message
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
