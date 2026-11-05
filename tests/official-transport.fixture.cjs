'use strict';
// Copied ONLY into a temporary E2E plugin directory. Production never reads
// this environment variable or substitutes its official transport endpoints.
const production = require('./official-bot-production.cjs');
const { OfficialAPI } = require('./official-api.cjs');
const WebSocket = require('ws');
const base = process.env.QQ_OFFICIAL_FIXTURE_BASE;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base || '')) throw Error('isolated-official-fixture-required');
module.exports = { ...production, OfficialBot: class extends production.OfficialBot {
  constructor(config) {
    super(config, { api: new OfficialAPI(config, { fetchImpl: (url, options) => fetch(base + new URL(url).pathname, options) }),
      socketFactory: () => new WebSocket(base.replace('http:', 'ws:') + '/gateway') });
  }
} };
