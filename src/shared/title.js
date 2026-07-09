'use strict';

const path = require('path');
const { getAgent } = require('./agents');

const MAX_LABEL = 20;

/** Truncate to `max` chars total, with an ellipsis occupying the last 3. */
function truncate(text, max = MAX_LABEL) {
  if (typeof text !== 'string') return text;
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

// Agents announce their state through the terminal's OSC 0/2 "set window title"
// escape. Because we own the PTY we read that title directly from xterm, rather
// than scraping Terminal.app window titles over AppleScript.
const SEPARATOR = /--+\s*(.+)$|[—–]\s*(.+)$/;

/**
 * Extract structured info from an agent-set terminal title.
 * Titles look like "/Users/me/project -- Fix auth bug" or just "/Users/me/proj".
 */
function parseAgentInfo(title) {
  if (typeof title !== 'string') return null;

  const info = { agent: null, project: null, chatName: null, summary: null };
  const lower = title.toLowerCase();

  if (lower.includes('claude')) info.agent = 'claude';
  else if (lower.includes('amp')) info.agent = 'amp';
  else if (lower.includes('codex')) info.agent = 'codex';

  const sep = title.match(SEPARATOR);
  if (sep) {
    const raw = (sep[1] || sep[2] || '').trim();
    if (raw.length > 0) info.chatName = truncate(raw);
  }

  // The path, if present, is whatever precedes the separator.
  const beforeSep = title.split(SEPARATOR)[0] || title;
  const pathMatch = beforeSep.match(/(\/\S+)/);
  if (pathMatch) {
    const p = pathMatch[1].replace(/\/+$/, '');
    info.project = path.basename(p) || p;
  }

  if (info.chatName) {
    info.summary = info.chatName;
  } else if (title.length > 0 && !title.startsWith('/')) {
    info.summary = truncate(title);
  }

  return info;
}

/**
 * Resolve the label shown on a dock slot.
 *
 * Priority: user rename > agent-set title > session summary > cwd > "Claude 2".
 */
function generateSlotName({
  customName,
  title,
  cwd,
  sessionSummary,
  agentKey,
  index,
} = {}) {
  if (customName) return customName;

  const info = title ? parseAgentInfo(title) : null;
  if (info && info.chatName) return info.chatName;
  if (info && info.summary) return info.summary;

  if (sessionSummary) return truncate(sessionSummary);

  if (info && info.project) return info.project;
  if (cwd) {
    const base = path.basename(cwd);
    if (base) return truncate(base);
  }

  return `${getAgent(agentKey).shortName} ${index}`;
}

module.exports = { truncate, parseAgentInfo, generateSlotName, MAX_LABEL };
