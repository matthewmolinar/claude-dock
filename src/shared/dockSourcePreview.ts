import type { SupportedSourceDocumentExtension } from './dockHostTypes'

export type SourceDocumentPreviewFailureReason =
  | 'invalid_path'
  | 'not_allowed'
  | 'unsupported_format'
  | 'not_found'
  | 'not_file'
  | 'too_large'
  | 'invalid_encoding'
  | 'unreadable'

export type SourceDocumentPreviewResult =
  | {
      ok: true
      title: string
      relativePath: string
      extension: SupportedSourceDocumentExtension
      text: string
    }
  | {
      ok: false
      reason: SourceDocumentPreviewFailureReason
      message: string
    }
