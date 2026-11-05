'use strict';
// Copied ONLY into a temporary E2E plugin directory. Production never reads
// this environment variable or substitutes its official transport endpoints.
const production = require('./official-bot-production.cjs');
const { OfficialAPI } = require('./official-api.cjs');
const base = process.env.QQ_OFFICIAL_FIXTURE_BASE;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base || '')) throw Error('isolated-official-fixture-required');
module.exports = { ...production, OfficialBot: class extends production.OfficialBot {
  constructor(config) {
    super(config, { api: new OfficialAPI(config, {createClients:async()=>{
      const {TokenManager,ApiClient}=await import('@tencent-connect/qqbot-nodejs/protocol');
      return {tokens:new TokenManager({baseUrl:base}),client:new ApiClient({baseUrl:base})};
    }}),gatewayFactory:async options=>{
      const {GatewayConnection}=await import('@tencent-connect/qqbot-nodejs/protocol');
      return new GatewayConnection({...options,reconnect:{maxAttempts:3,delays:[200,400,800]},
        getGatewayUrl:async()=>{await options.getGatewayUrl();return base.replace('http:','ws:')+'/gateway';}});
    }});
  }
} };
