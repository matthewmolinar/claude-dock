'use strict';

// Pure layout constants shared by the main process (window sizing) and the
// dock renderer (CSS custom properties). Keep these two in sync via IPC rather
// than duplicating literals.
const LAYOUT = {
  slotWidth: 140,
  slotHeight: 60,
  gap: 8,
  margin: 10,
  bottomOffset: 5,
  addButtonWidth: 40,
  tabHeight: 28,
  initialSlots: 3,
};

function getDockWidth(slotCount, layout = LAYOUT) {
  const { slotWidth, gap, addButtonWidth, margin } = layout;
  return (
    slotWidth * slotCount +
    gap * (slotCount - 1) +
    gap +
    addButtonWidth +
    margin * 2
  );
}

function getDockHeight(layout = LAYOUT) {
  return layout.tabHeight + layout.slotHeight + layout.margin * 2;
}

/**
 * Compute the dock's on-screen frame.
 *
 * `workArea` already excludes the macOS menu bar and the system Dock, whichever
 * edge it lives on. That is why this app needs no Accessibility permission and
 * no `defaults write com.apple.dock orientation` workaround.
 */
function computeDockFrame(workArea, slotCount, layout = LAYOUT) {
  const width = getDockWidth(slotCount, layout);
  const height = getDockHeight(layout);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - height - layout.bottomOffset),
    width,
    height,
  };
}

module.exports = { LAYOUT, getDockWidth, getDockHeight, computeDockFrame };
