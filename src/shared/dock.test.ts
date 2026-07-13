import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  LAYOUT,
  computeDockFrame,
  getDockHeight,
  getDockWidth,
  prettyFolder,
  slotLabel,
  truncate,
} from './dock'

// A 1512x982 work area is a 16" MBP with the menu bar and a left-side Dock.
const WORK_AREA = { x: 79, y: 38, width: 1433, height: 944 }

test('getDockWidth scales with slotCount', () => {
  assert.ok(getDockWidth(4) > getDockWidth(3))
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

test('computeDockFrame widens as slots are added', () => {
  const three = computeDockFrame(WORK_AREA, 3)
  const five = computeDockFrame(WORK_AREA, 5)
  assert.ok(five.width > three.width)
  assert.equal(five.height, three.height)
  assert.ok(five.x < three.x, 'stays centered as it grows')
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

test('slotLabel falls back to "Session N"', () => {
  assert.equal(slotLabel({ index: 2 }), 'Session 2')
})

test('prettyFolder abbreviates the home directory', () => {
  assert.equal(prettyFolder('/Users/molinar/lore', '/Users/molinar'), '~/lore')
  assert.equal(prettyFolder('/opt/thing', '/Users/molinar'), '/opt/thing')
  assert.equal(prettyFolder('', '/Users/molinar'), '')
})
