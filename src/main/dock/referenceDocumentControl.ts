export interface ReferenceDocumentSelection {
  canceled: boolean
  filePaths: string[]
}

export async function addReferenceDocumentsForSender<TSender, TOutcome>(options: {
  sender: TSender
  indexForSender(sender: TSender): number
  pick(): Promise<ReferenceDocumentSelection>
  ingest(index: number, sourcePath: string): Promise<TOutcome>
}): Promise<void> {
  if (options.indexForSender(options.sender) === -1) return

  const picked = await options.pick()
  if (picked.canceled || picked.filePaths.length === 0) return

  for (const sourcePath of picked.filePaths) {
    const index = options.indexForSender(options.sender)
    if (index === -1) return
    await options.ingest(index, sourcePath)
  }
}
