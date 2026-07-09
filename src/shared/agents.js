'use strict';

// Supported agents. Order controls tab display order.
const AGENT_ORDER = ['claude', 'amp', 'codex'];

const AGENTS = {
  claude: {
    key: 'claude',
    command: 'claude',
    name: 'Claude',
    shortName: 'Claude',
    color: '#C15F3C',
  },
  amp: {
    key: 'amp',
    command: 'amp',
    name: 'Amp',
    shortName: 'Amp',
    color: '#9933CC',
  },
  codex: {
    key: 'codex',
    command: 'codex',
    name: 'Codex',
    shortName: 'Codex',
    color: '#00A67E',
  },
};

const DEFAULT_AGENT = 'claude';

function getAgent(key) {
  return AGENTS[key] || AGENTS[DEFAULT_AGENT];
}

module.exports = { AGENT_ORDER, AGENTS, DEFAULT_AGENT, getAgent };
