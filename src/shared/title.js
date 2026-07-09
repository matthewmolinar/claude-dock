'use strict';

const path = require('path');

const MAX_LABEL = 22;

/** Truncate to `max` chars total, with an ellipsis occupying the last character. */
function truncate(text, max = MAX_LABEL) {
  if (typeof text !== 'string') return text;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Resolve the label shown on a dock slot.
 *
 * Priority: user rename > what they first asked for > folder name > "Session 2".
 */
function slotLabel({ customName, firstPrompt, folder, index } = {}) {
  if (customName) return truncate(customName);
  if (firstPrompt) return truncate(firstPrompt);
  if (folder) {
    const base = path.basename(folder);
    if (base) return truncate(base);
  }
  return `Session ${index}`;
}

/** "/Users/molinar/lore" -> "~/lore" */
function prettyFolder(folder, home = process.env.HOME || '') {
  if (!folder) return '';
  if (home && folder.startsWith(home)) return `~${folder.slice(home.length)}`;
  return folder;
}

module.exports = { truncate, slotLabel, prettyFolder, MAX_LABEL };
