/**
 * Pure source-inventory projection shared by hosts and renderers. Keep this
 * module free of filesystem, Electron, and Lore API imports.
 */
import type { RegisteredSlotSource, SourceDocumentItem, SourcesPayload } from './dock'

interface PendingSourceSummary {
  relativePath: string
  title: string
  registrationFailed?: boolean
}

export interface MergeSourceDocumentsArgs {
  registered: readonly RegisteredSlotSource[]
  pending: readonly PendingSourceSummary[]
  loadState: SourcesPayload['loadState']
}

function normalizedRelativePath(relativePath: string): string | null {
  const posixPath = relativePath.replace(/\\/g, '/')
  if (posixPath.length === 0 || posixPath.startsWith('/') || /^[A-Za-z]:\//.test(posixPath)) return null
  const segments: string[] = []
  for (const segment of posixPath.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  return segments.length > 0 ? segments.join('/') : null
}

/**
 * Merge the authoritative registry with the durable local registration queue.
 * Registry rows sort newest-first, then by path, so response-order changes do
 * not make the UI flicker. Pending-only rows follow in normalized path order.
 */
export function mergeSourceDocuments(args: MergeSourceDocumentsArgs): SourcesPayload {
  const documents: SourceDocumentItem[] = []
  const seen = new Set<string>()
  const registered = args.registered
    .filter((source) => source.kind === 'document')
    .slice()
    .sort((a: RegisteredSlotSource, b: RegisteredSlotSource) => b.boundAt.localeCompare(a.boundAt)
      || (normalizedRelativePath(a.relativePath) ?? '').localeCompare(normalizedRelativePath(b.relativePath) ?? ''))

  for (const source of registered) {
    const key = normalizedRelativePath(source.relativePath)
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    documents.push({ relativePath: key, title: source.title, state: 'ready' })
  }

  const pending = args.pending.slice().sort((a: PendingSourceSummary, b: PendingSourceSummary) =>
    (normalizedRelativePath(a.relativePath) ?? '').localeCompare(normalizedRelativePath(b.relativePath) ?? ''))
  for (const source of pending) {
    const key = normalizedRelativePath(source.relativePath)
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    documents.push({
      relativePath: key,
      title: source.title,
      state: source.registrationFailed === true ? 'waiting' : 'pending',
    })
  }

  return { loadState: args.loadState, documents }
}
