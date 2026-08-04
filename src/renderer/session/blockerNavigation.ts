export type BlockerTarget = 'review' | 'approval' | 'reconcile'

function referencedOutcome(root: ParentNode, turnRef: string): HTMLElement | null {
  return [...root.querySelectorAll<HTMLElement>('.outcome')]
    .find((element) => element.dataset.promptBlockId === turnRef) ?? null
}

/** Resolve only a surface explicitly belonging to the authoritative blocker Turn. */
export function resolveBlockerDestination(root: ParentNode, target: BlockerTarget, turnRef: string): HTMLElement | null {
  if (target === 'approval') {
    return [...root.querySelectorAll<HTMLElement>('.approval-card')]
      .find((element) => element.dataset.state === 'answerable' && element.dataset.promptBlockId === turnRef) ?? null
  }
  const outcome = referencedOutcome(root, turnRef)
  if (!outcome || target === 'reconcile') return outcome
  return outcome.querySelector<HTMLElement>('.review-card') ?? outcome
}
