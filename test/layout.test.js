'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { LAYOUT, getDockWidth, getDockHeight, computeDockFrame } = require('../src/shared/layout');

// A 1512x982 work area is a 16" MBP with the menu bar and a left-side Dock.
const WORK_AREA = { x: 79, y: 38, width: 1433, height: 944 };

test('getDockWidth scales with slotCount', () => {
  assert.ok(getDockWidth(4) > getDockWidth(3));
});

test('getDockHeight is constant regardless of slotCount', () => {
  assert.strictEqual(getDockHeight(), getDockHeight());
  assert.strictEqual(getDockHeight(), LAYOUT.headerHeight + LAYOUT.slotHeight + LAYOUT.margin * 2);
});

test('computeDockFrame returns x, y, width, height', () => {
  const f = computeDockFrame(WORK_AREA, 3);
  for (const k of ['x', 'y', 'width', 'height']) {
    assert.strictEqual(typeof f[k], 'number', `${k} should be a number`);
  }
});

test('computeDockFrame centers the dock within the work area', () => {
  const f = computeDockFrame(WORK_AREA, 3);
  const leftGap = f.x - WORK_AREA.x;
  const rightGap = WORK_AREA.x + WORK_AREA.width - (f.x + f.width);
  assert.ok(Math.abs(leftGap - rightGap) <= 1, `centered: ${leftGap} vs ${rightGap}`);
});

test('computeDockFrame sits inside the work area, above the system Dock', () => {
  const f = computeDockFrame(WORK_AREA, 3);
  const workBottom = WORK_AREA.y + WORK_AREA.height;
  assert.strictEqual(f.y + f.height, workBottom - LAYOUT.bottomOffset);
  assert.ok(f.y >= WORK_AREA.y, 'never overlaps the menu bar');
  assert.ok(f.x >= WORK_AREA.x, 'never overlaps a left-side Dock');
});

test('computeDockFrame respects a work area offset by a bottom Dock', () => {
  // Bottom Dock shrinks workArea.height; the dock must ride above it.
  const bottomDock = { x: 0, y: 38, width: 1512, height: 850 };
  const f = computeDockFrame(bottomDock, 3);
  assert.ok(f.y + f.height <= bottomDock.y + bottomDock.height);
});

test('computeDockFrame widens as slots are added', () => {
  const three = computeDockFrame(WORK_AREA, 3);
  const five = computeDockFrame(WORK_AREA, 5);
  assert.ok(five.width > three.width);
  assert.strictEqual(five.height, three.height);
  assert.ok(five.x < three.x, 'stays centered as it grows');
});
