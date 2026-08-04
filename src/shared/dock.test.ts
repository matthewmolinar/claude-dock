import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ARTIFACT_PANE_MIN_WIDTH,
  IN_APP_BOTTOM_CLEARANCE,
  LAYOUT,
  SESSION_MIN_HEIGHT,
  SESSION_MIN_WIDTH,
  SESSION_TURN_OUTCOMES,
  TURN_FAILURE_TEXT,
  clampArtifactPaneWidth,
  clampDockFrame,
  describeTurnOutcome,
  clampEmbeddedSessionFrame,
  computeDockFrame,
  computeEmbeddedSessionFrame,
  computeInAppDockFrame,
  embeddedSessionRegion,
  expandedFrameForHandle,
  expandedSessionWidth,
  getDockHeight,
  getDockWidth,
  isTypeId,
  prettyFolder,
  resolveTrapTarget,
  slotLabel,
  truncate,
  type TrapRect,
  type ToolStartPayload,
} from './dock'

test('tool presentation DTO retains complete opaque input', () => {
  const input = { question: 'q'.repeat(4000), nested: { source: 'full' } }
  const payload: ToolStartPayload = { id: 'call-1', label: 'Ask Lore', input }
  assert.deepEqual(payload.input, input)
})

// A 1512x982 work area is a 16" MBP with the menu bar and a left-side Dock.
const WORK_AREA = { x: 79, y: 38, width: 1433, height: 944 }

test('getDockWidth never shrinks below its usable minimum', () => {
  assert.ok(getDockWidth(0) >= LAYOUT.minWidth)
  assert.ok(getDockWidth(1) >= LAYOUT.minWidth)
})

test('getDockWidth scales with slotCount', () => {
  assert.ok(getDockWidth(4) > getDockWidth(3))
})

test('getDockWidth only reserves space for in-flow controls', () => {
  const expected =
    LAYOUT.micButtonWidth +
    LAYOUT.gap +
    LAYOUT.slotWidth * 3 +
    LAYOUT.gap * 2 +
    LAYOUT.gap +
    LAYOUT.addButtonWidth +
    LAYOUT.margin * 2
  assert.equal(getDockWidth(3), expected)
})

test('getDockHeight is constant regardless of slotCount', () => {
  assert.equal(getDockHeight(), getDockHeight())
  assert.equal(getDockHeight(), LAYOUT.headerHeight + LAYOUT.slotHeight + LAYOUT.margin * 2)
})

test('computeDockFrame returns x, y, width, height', () => {
  const f = computeDockFrame(WORK_AREA, 3)
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    assert.equal(typeof f[k], 'number', `${k} should be a number`)
  }
})

test('computeDockFrame centers the dock within the work area', () => {
  const f = computeDockFrame(WORK_AREA, 3)
  const leftGap = f.x - WORK_AREA.x
  const rightGap = WORK_AREA.x + WORK_AREA.width - (f.x + f.width)
  assert.ok(Math.abs(leftGap - rightGap) <= 1, `centered: ${leftGap} vs ${rightGap}`)
})

test('computeDockFrame sits inside the work area, above the system Dock', () => {
  const f = computeDockFrame(WORK_AREA, 3)
  const workBottom = WORK_AREA.y + WORK_AREA.height
  assert.equal(f.y + f.height, workBottom - LAYOUT.bottomOffset)
  assert.ok(f.y >= WORK_AREA.y, 'never overlaps the menu bar')
  assert.ok(f.x >= WORK_AREA.x, 'never overlaps a left-side Dock')
})

test('computeDockFrame respects a work area offset by a bottom Dock', () => {
  // Bottom Dock shrinks workArea.height; the dock must ride above it.
  const bottomDock = { x: 0, y: 38, width: 1512, height: 850 }
  const f = computeDockFrame(bottomDock, 3)
  assert.ok(f.y + f.height <= bottomDock.y + bottomDock.height)
})

test('computeDockFrame fits inside a work area smaller than the dock', () => {
  const tinyWorkArea = { x: 10, y: 20, width: 320, height: 80 }
  assert.deepEqual(computeDockFrame(tinyWorkArea, 12), {
    x: tinyWorkArea.x,
    y: tinyWorkArea.y,
    width: tinyWorkArea.width,
    height: tinyWorkArea.height,
  })
})

test('computeDockFrame widens as slots are added', () => {
  const three = computeDockFrame(WORK_AREA, 3)
  const five = computeDockFrame(WORK_AREA, 5)
  assert.ok(five.width > three.width)
  assert.equal(five.height, three.height)
  assert.ok(five.x < three.x, 'stays centered as it grows')
})

test('computeInAppDockFrame stays centered and floats clear of the bottom border', () => {
  const f = computeInAppDockFrame(WORK_AREA, 3)
  const leftGap = f.x - WORK_AREA.x
  const rightGap = WORK_AREA.x + WORK_AREA.width - (f.x + f.width)
  assert.ok(Math.abs(leftGap - rightGap) <= 1)
  assert.equal(
    f.y + f.height,
    WORK_AREA.y + WORK_AREA.height - LAYOUT.bottomOffset - IN_APP_BOTTOM_CLEARANCE,
  )
})

test('computeInAppDockFrame grows its card shelf upward without moving the strip', () => {
  const closed = computeInAppDockFrame(WORK_AREA, 3)
  const open = computeInAppDockFrame(WORK_AREA, 3, true)
  assert.equal(open.height, closed.height + LAYOUT.shelfHeight)
  assert.equal(open.y, closed.y - LAYOUT.shelfHeight)
  assert.equal(open.y + open.height, closed.y + closed.height)
})

// The main Lore window's content bounds with the app bar and sidebar insets.
const CONTENT = { x: 100, y: 100, width: 1200, height: 1000 }
const INSETS = { top: 40, left: 264 }

test('embeddedSessionRegion stays clear of app bar, sidebar, and strip', () => {
  const region = embeddedSessionRegion(CONTENT, INSETS)
  assert.equal(region.x, CONTENT.x + INSETS.left)
  assert.equal(region.y, CONTENT.y + INSETS.top)
  assert.equal(region.width, CONTENT.width - INSETS.left)
  assert.equal(
    region.y + region.height,
    CONTENT.y + CONTENT.height - getDockHeight() - LAYOUT.bottomOffset - IN_APP_BOTTOM_CLEARANCE,
  )
})

test('computeEmbeddedSessionFrame opens inside the region and cascades', () => {
  const region = embeddedSessionRegion(CONTENT, INSETS)
  const first = computeEmbeddedSessionFrame(CONTENT, INSETS, 0)
  const second = computeEmbeddedSessionFrame(CONTENT, INSETS, 1)
  assert.ok(first.x >= region.x)
  assert.ok(first.y >= region.y)
  assert.ok(first.x + first.width <= region.x + region.width)
  assert.ok(first.y + first.height <= region.y + region.height)
  assert.equal(second.x, first.x + 28)
  assert.equal(second.y, first.y + 28)
})

test('computeEmbeddedSessionFrame never shrinks below the session floor', () => {
  const tiny = { x: 0, y: 0, width: 500, height: 400 }
  const f = computeEmbeddedSessionFrame(tiny, INSETS, 0)
  assert.equal(f.width, SESSION_MIN_WIDTH)
  assert.equal(f.height, SESSION_MIN_HEIGHT)
})

test('clampEmbeddedSessionFrame pulls a stranded window back into the region', () => {
  const region = embeddedSessionRegion(CONTENT, INSETS)
  const f = clampEmbeddedSessionFrame(
    { x: 5_000, y: 5_000, width: 760, height: 680 },
    CONTENT,
    INSETS,
  )
  assert.equal(f.x + f.width, region.x + region.width)
  assert.equal(f.y + f.height, region.y + region.height)
  assert.equal(f.width, 760)
  assert.equal(f.height, Math.min(680, region.height))
})

test('clampEmbeddedSessionFrame keeps an in-region window untouched', () => {
  const inside = computeEmbeddedSessionFrame(CONTENT, INSETS, 0)
  assert.deepEqual(clampEmbeddedSessionFrame(inside, CONTENT, INSETS), inside)
})

test('clampDockFrame preserves a visible user position', () => {
  const f = clampDockFrame(WORK_AREA, { x: 240, y: 300 }, 3)
  assert.equal(f.x, 240)
  assert.equal(f.y, 300)
})

test('clampDockFrame keeps every edge inside the work area', () => {
  const topLeft = clampDockFrame(WORK_AREA, { x: -500, y: -500 }, 3)
  assert.equal(topLeft.x, WORK_AREA.x)
  assert.equal(topLeft.y, WORK_AREA.y)

  const bottomRight = clampDockFrame(WORK_AREA, { x: 9_999, y: 9_999 }, 3)
  assert.equal(bottomRight.x + bottomRight.width, WORK_AREA.x + WORK_AREA.width)
  assert.equal(bottomRight.y + bottomRight.height, WORK_AREA.y + WORK_AREA.height)
})

test('clampDockFrame fits an oversized dock to the work area', () => {
  const narrowWorkArea = { x: 80, y: 40, width: 400, height: 300 }
  const f = clampDockFrame(narrowWorkArea, { x: 300, y: 100 }, 4)
  assert.equal(f.x, narrowWorkArea.x)
  assert.equal(f.y, 100)
  assert.equal(f.width, narrowWorkArea.width)
  assert.equal(f.x + f.width, narrowWorkArea.x + narrowWorkArea.width)
})

test('expandedFrameForHandle centers the open strip on the handle, bottom-aligned', () => {
  const workArea = { x: 0, y: 0, width: 1440, height: 900 }
  const width = getDockWidth(3, LAYOUT)
  const height = getDockHeight(LAYOUT)
  const handle = { x: 700, y: 900 - LAYOUT.compactHeight }
  const f = expandedFrameForHandle(workArea, handle, 3, LAYOUT)
  assert.equal(f.width, width)
  assert.equal(f.height, height)
  // Centered on the handle's horizontal center (700 + compactWidth/2).
  assert.equal(f.x, Math.round(handle.x + LAYOUT.compactWidth / 2 - width / 2))
  // The handle's bottom edge (900) becomes the strip's bottom edge.
  assert.equal(f.y + f.height, 900)
})

test('expandedFrameForHandle clamps a handle hugging the right edge', () => {
  const workArea = { x: 0, y: 0, width: 1440, height: 900 }
  const f = expandedFrameForHandle(workArea, { x: 1430, y: 858 }, 3)
  assert.ok(f.x >= workArea.x)
  assert.equal(f.x + f.width, workArea.x + workArea.width)
})

test('expandedFrameForHandle keeps a handle placement on its secondary display', () => {
  // A work area offset to the right of the primary display.
  const workArea = { x: 1440, y: 0, width: 1920, height: 1080 }
  const handle = { x: 1440 + 900, y: 1080 - LAYOUT.compactHeight }
  const f = expandedFrameForHandle(workArea, handle, 3)
  assert.ok(f.x >= workArea.x, 'stays on the secondary display')
  assert.ok(f.x + f.width <= workArea.x + workArea.width)
  assert.equal(f.y + f.height, 1080)
})

test('expandedSessionWidth adds the pane width', () => {
  assert.equal(expandedSessionWidth(760, 2000), 1240)
})

test('expandedSessionWidth clamps to the work area', () => {
  assert.equal(expandedSessionWidth(760, 1100), 1060)
})

test('clampArtifactPaneWidth preserves usable artifact and chat columns', () => {
  assert.equal(clampArtifactPaneWidth(200, 1000), ARTIFACT_PANE_MIN_WIDTH)
  assert.equal(clampArtifactPaneWidth(500, 1000), 500)
  assert.equal(clampArtifactPaneWidth(900, 1000), 720)
})

test('truncate leaves short strings alone', () => {
  assert.equal(truncate('short'), 'short')
})

test('truncate caps at 22 chars including the ellipsis', () => {
  const out = truncate('This is a very long thing the user asked for')
  assert.equal(out.length, 22)
  assert.ok(out.endsWith('…'))
})

test('truncate collapses newlines and runs of whitespace', () => {
  assert.equal(truncate('fix\n\n  the   bug'), 'fix the bug')
})

test('slotLabel prefers the user rename above everything', () => {
  const label = slotLabel({ customName: 'Taxes', firstPrompt: 'do my taxes', folder: '/x', index: 1 })
  assert.equal(label, 'Taxes')
})

test('slotLabel falls back to what they first asked for', () => {
  assert.equal(slotLabel({ firstPrompt: 'fix the login bug', index: 1 }), 'fix the login bug')
})

test('slotLabel truncates a long first prompt', () => {
  const label = slotLabel({ firstPrompt: 'please rewrite the entire onboarding flow', index: 1 })
  assert.equal(label.length, 22)
  assert.ok(label.endsWith('…'))
})

test('slotLabel falls back to the folder name', () => {
  assert.equal(slotLabel({ folder: '/Users/me/lore', index: 1 }), 'lore')
})

test('slotLabel falls back to "Slot N", never "Session N"', () => {
  assert.equal(slotLabel({ index: 2 }), 'Slot 2')
})

test('prettyFolder abbreviates the home directory', () => {
  assert.equal(prettyFolder('/Users/molinar/lore', '/Users/molinar'), '~/lore')
  assert.equal(prettyFolder('/opt/thing', '/Users/molinar'), '/opt/thing')
  assert.equal(prettyFolder('', '/Users/molinar'), '')
})

// ---------------------------------------------------------------------------
// resolveTrapTarget — the drop-target hysteresis state machine.
// ---------------------------------------------------------------------------

// Two non-overlapping targets, far enough apart that release margins don't meet.
const A: TrapRect = { index: 0, left: 0, top: 0, right: 100, bottom: 100 }
const B: TrapRect = { index: 1, left: 200, top: 0, right: 300, bottom: 100 }
const center = (rect: TrapRect) => ({ x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 })

test('resolveTrapTarget returns null when there are no targets', () => {
  assert.equal(resolveTrapTarget({ x: 50, y: 50 }, [], null), null)
})

test('resolveTrapTarget traps a point inside a target rect', () => {
  assert.equal(resolveTrapTarget(center(A), [A, B], null), 0)
  assert.equal(resolveTrapTarget(center(B), [A, B], null), 1)
})

test('resolveTrapTarget holds the trap within releaseMargin, then releases beyond it', () => {
  // Just past A's right edge (100) but inside the default 24px release margin.
  assert.equal(resolveTrapTarget({ x: 120, y: 50 }, [A, B], 0), 0)
  // Beyond the release margin (100 + 24 = 124) → the trap releases.
  assert.equal(resolveTrapTarget({ x: 130, y: 50 }, [A, B], 0), null)
})

test('resolveTrapTarget lets a direct hit on another target steal the trap', () => {
  // Trapped in A, but the pointer is dead-center over B → B wins.
  assert.equal(resolveTrapTarget(center(B), [A, B], 0), 1)
})

test('resolveTrapTarget honors a custom releaseMargin', () => {
  // With a tight 5px margin, x=120 is outside A's grown bounds (100 + 5 = 105).
  assert.equal(resolveTrapTarget({ x: 120, y: 50 }, [A, B], 0, 5), null)
  // A generous 50px margin keeps the same point trapped.
  assert.equal(resolveTrapTarget({ x: 120, y: 50 }, [A, B], 0, 50), 0)
})

// ---- how a settled turn presents -------------------------------------------
// One fixture per value of the closed Outcome set, plus the two skew cases: a
// value this build does not know, and a host that derives no outcome at all.

test('only verified_success earns "Done" and the checkmark', () => {
  assert.deepEqual(describeTurnOutcome('verified_success'), { headline: 'Done', verified: true })
  for (const value of SESSION_TURN_OUTCOMES) {
    if (value === 'verified_success') continue
    assert.equal(describeTurnOutcome(value)?.verified ?? false, false, `${value} must not claim a checkmark`)
  }
})

test('unverified_completion is a neutral finish with no hedging in the headline', () => {
  assert.deepEqual(describeTurnOutcome('unverified_completion'), { headline: 'Finished', verified: false })
})

test('partial_success, blocked, exhausted, and cancelled each say what happened', () => {
  assert.deepEqual(describeTurnOutcome('partial_success'), { headline: 'Partially done', verified: false })
  assert.deepEqual(describeTurnOutcome('blocked'), { headline: 'Needs you', verified: false })
  assert.deepEqual(describeTurnOutcome('exhausted'), { headline: 'Ran out of budget', verified: false })
  assert.deepEqual(describeTurnOutcome('cancelled'), { headline: 'Stopped', verified: false })
})

test('failed carries the failure copy itself, so no host has to supply it', () => {
  // This module is byte-synced to the OSS workbench repo WITHOUT the Lore
  // mapper that emits an error entry alongside a failed turn. If the copy
  // lived only in that mapper, a standalone host calling `sink.outcome`
  // ('failed') would render complete silence — the same defect this change
  // fixed on the Lore side, reproduced one repo over with nothing to catch it.
  assert.deepEqual(describeTurnOutcome('failed'), { headline: TURN_FAILURE_TEXT, verified: false })
  assert.deepEqual(describeTurnOutcome('failed', 'tb_prompt'), { headline: TURN_FAILURE_TEXT, verified: false, promptBlockId: 'tb_prompt' })
})

test('unknown renders the stable reference it was handed, and nothing to press', () => {
  assert.deepEqual(describeTurnOutcome('unknown', 'tb_prompt'), {
    headline: 'Unconfirmed — needs review',
    verified: false,
    promptBlockId: 'tb_prompt',
    reference: 'tb_prompt',
  })
  // Having no reference to quote is still not grounds for a retry affordance.
  assert.deepEqual(describeTurnOutcome('unknown'), {
    headline: 'Unconfirmed — needs review',
    verified: false,
  })
})

test('a reference is quoted only where a person is being asked to reconcile', () => {
  for (const value of SESSION_TURN_OUTCOMES) {
    if (value === 'unknown') continue
    assert.equal(describeTurnOutcome(value, 'tb_prompt')?.reference, undefined, `${value} must not quote a reference`)
  }
})

test('an outcome this build does not know renders as a non-committal completion', () => {
  assert.deepEqual(describeTurnOutcome('reconciled_later'), { headline: 'Finished', verified: false })
  assert.deepEqual(describeTurnOutcome('reconciled_later', 'tb_prompt'), { headline: 'Finished', verified: false })
})

test('no outcome at all renders exactly as it did before outcomes existed: nothing', () => {
  assert.equal(describeTurnOutcome(undefined), null)
  assert.equal(describeTurnOutcome(''), null)
})

test('the detail is carried one layer deeper, never into the headline', () => {
  // The gap this closes: `unverified_completion` and a value this build cannot
  // name both headline "Finished", so a neutral finish was indistinguishable
  // from a fallback. The detail is what tells them apart — and it must not
  // move the headline, or the neutrality it protects is gone.
  const detailed = describeTurnOutcome(
    'unverified_completion',
    undefined,
    'Made 1 change, but could not check it.',
  )
  assert.deepEqual(detailed, {
    headline: 'Finished',
    verified: false,
    detail: 'Made 1 change, but could not check it.',
  })
  assert.equal(detailed?.headline, describeTurnOutcome('unverified_completion')?.headline)
})

test('a detail never upgrades a claim: no checkmark, no reference it was not given', () => {
  for (const value of SESSION_TURN_OUTCOMES) {
    const presentation = describeTurnOutcome(value, undefined, 'Made and checked 3 changes.')
    assert.equal(
      presentation?.verified ?? false,
      value === 'verified_success',
      `${value} changed its checkmark because of prose`,
    )
    assert.equal(presentation?.reference, undefined, `${value} invented a reference`)
  }
})

test('an outcome this build cannot name is given no detail to speak with', () => {
  // The fallback headline is deliberately non-committal because this build does
  // not know what the value means. Pairing it with the host's own prose about
  // that value would let a future host's wording bypass this module's copy
  // discipline entirely — and would re-merge the two cases the layer exists to
  // separate. An unnameable outcome renders exactly as it did before.
  assert.deepEqual(describeTurnOutcome('reconciled_later', undefined, 'Reconciled 2 changes later.'), {
    headline: 'Finished',
    verified: false,
  })
  assert.deepEqual(describeTurnOutcome('reconciled_later', 'tb_prompt', 'Reconciled 2 changes later.'), {
    headline: 'Finished',
    verified: false,
  })
})

test('an empty detail is the same as none: a blank second line is worse than no line', () => {
  assert.deepEqual(describeTurnOutcome('unverified_completion', undefined, ''), {
    headline: 'Finished',
    verified: false,
  })
})

test('a detail alone never makes a turn render: no outcome is still nothing', () => {
  assert.equal(describeTurnOutcome(undefined, undefined, 'Made and checked 3 changes.'), null)
  assert.equal(describeTurnOutcome('', 'tb_prompt', 'Made and checked 3 changes.'), null)
})

test('no settled turn ever renders as silence, whatever host compiled this', () => {
  // No exceptions and no `continue`. A value that renders nothing is a settled
  // turn that says nothing, and this module cannot lean on any other module
  // having spoken first — none of them travel with it to the OSS repo.
  for (const value of SESSION_TURN_OUTCOMES) {
    const presentation = describeTurnOutcome(value)
    assert.ok(presentation, `${value} renders nothing at all`)
    assert.ok(presentation.headline.length > 0, `${value} renders an empty headline`)
  }
  // The forward-skew case too: an unnameable value is still not silence.
  assert.ok(describeTurnOutcome('reconciled_later')?.headline)
})

test('IPC TypeID inputs require a canonical 128-bit base62 suffix and exact prefix', () => {
  assert.equal(isTypeId('evb_032txNY4fSRGqxb6HXj3S6', 'evb'), true)
  assert.equal(isTypeId('org_032txNY4fSRGqxb6HXj3S6', 'org'), true)
  assert.equal(isTypeId('dfx_032txNY4fSRGqxb6HXj3S6', 'dfx'), true)
  for (const value of ['evb_123ABC', 'evb_032txNY4fSRGqxb6HXj3S/', 'evb_zzzzzzzzzzzzzzzzzzzzzz', 'org_032txNY4fSRGqxb6HXj3S6', ' evb_032txNY4fSRGqxb6HXj3S6', 1, null]) {
    assert.equal(isTypeId(value, 'evb'), false)
  }
})
