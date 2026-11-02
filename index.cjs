'use strict';
const { createHash } = require('node:crypto');
const { Engine, validateConfig } = require('./src/engine.cjs');
const { createGroupService } = require('./src/group-service.cjs');
module.exports.activate = async function (pet) {
  if (!pet.conversation?.bind || !pet.profile?.getScope) throw Error('需要支持外部会话接口的测试宿主。此版本尚未面向旧宿主发布。');
  const groups = createGroupService(pet);
  let engine; let scope; let key; let binding; let state = 'disconnected'; let error = ''; let disposed = false; let epoch = 0; let setup = Promise.resolve(); let changeTimer;
  const current = async (expected = scope) => { const actual = await pet.profile.getScope(); return !disposed && actual.scopeId === expected?.scopeId && actual.revision === expected?.revision; };
  const notify = () => { clearTimeout(changeTimer); changeTimer = setTimeout(() => pet.conversation.changed().catch(() => {}), 120); };
  async function start(config, capturedEpoch) {
    const boundScope = scope; const boundKey = key;
    const candidate = new Engine({ config, ledger: await pet.secrets.get('ledger.' + boundKey) || {}, save: rows => pet.secrets.set('ledger.' + boundKey, rows), changed: notify, current: async () => capturedEpoch === epoch && await current(boundScope) });
    engine = candidate;
    try {
      await candidate.open();
      if (capturedEpoch !== epoch || !await current(boundScope)) throw Error('宠物身份已改变。');
      binding = await pet.conversation.bind({ service: 'qq-context', label: 'QQ 宠物 · ' + config.ownerQQ });
      state = 'connected'; error = '';
    } catch (e) { candidate.close(); if (capturedEpoch === epoch) { state = 'offline'; error = e.message; } }
  }
  async function restore() {
    const capturedEpoch = ++epoch; engine?.close(); engine = undefined; binding = null; state = 'disconnected'; error = '';
    scope = await pet.profile.getScope(); key = createHash('sha256').update(scope.scopeId).digest('hex').slice(0, 32);
    binding = await pet.conversation.getBinding();
    if (!binding) return;
    const saved = await pet.secrets.get('connection.' + key);
    if (!saved) { state = 'offline'; error = '连接凭据不可用，请解绑后重新连接。'; return; }
    state = 'connecting'; await start(JSON.parse(saved), capturedEpoch);
  }
  async function panel(caller) {
    if (caller?.sdkCaller?.kind !== 'plugin' || caller.sdkCaller.id !== 'qq-context' || caller.sdkCaller.context !== 'panel') throw Error('只能在本插件设置面板操作。');
    if (!await current()) throw Error('宠物身份正在切换。');
  }
  async function host(request, caller) {
    if (caller?.sdkCaller?.kind !== 'host' || caller.sdkCaller.id !== 'conversation' || caller.sdkCaller.context !== 'host') throw Error('只接受宿主聊天入口。');
    const active = await pet.conversation.getBinding();
    if (!await current() || !active || active.bindingId !== request?.bindingId || active.scopeId !== request.scopeId || !engine) throw Error('会话绑定已变化。');
  }
  const api = {
    ...groups.api,
    async state(caller) {
      await panel(caller);
      const config = await pet.storage.get('config.' + key, {});
      return { state: state === 'connected' && (!engine?.dsh.ready || !engine?.qq.ready) ? 'offline' : state, error, config, bound: !!binding, ...engine?.status(), bili: 'not-enabled' };
    },
    async connect(input, caller) {
      await panel(caller); if (binding || state === 'connecting') throw Error('请先解除现有绑定。');
      const config = validateConfig(input); const capturedEpoch = ++epoch; const savedKey = key; const savedScope = scope;
      const { dshToken, qqToken, ...safe } = config;
      await pet.secrets.set('connection.' + savedKey, JSON.stringify(config)); await pet.storage.set('config.' + savedKey, safe);
      if (capturedEpoch !== epoch || !await current(savedScope)) throw Error('宠物身份已改变，未启动连接。');
      state = 'connecting'; error = ''; setup = setup.then(() => start(config, capturedEpoch)); return { accepted: true };
    },
    async disconnect(caller) {
      await panel(caller); const savedKey = key; ++epoch; engine?.close(); engine = undefined;
      await pet.conversation.unbind(); binding = null; state = 'disconnected'; error = '';
      await pet.secrets.delete('connection.' + savedKey); return true;
    },
    async reconnect(caller) { await panel(caller); if (state === 'connecting') return false; setup = setup.then(restore); return true; },
    async start(request, caller) { await host(request, caller); return engine.submit(request.requestId, request.text); },
    async poll(request, caller) { await host(request, caller); return engine.poll(request.requestId); },
    async history(request, caller) { await host(request, caller); return engine.dsh.history(request.page, request.pageSize); },
    async cancel(request, caller) { await host(request, caller); return engine.cancel(request.requestId); },
  };
  await pet.services.provide('qq-context', api);
  void groups.start().catch(() => {});
  pet.events.on('host:context-changed', () => { void groups.contextChanged().catch(() => {}); });
  pet.events.on('host:context-changed', () => { ++epoch; engine?.close(); state = 'disconnected'; binding = null; setup = setup.then(restore).catch(() => { state = 'offline'; error = '切换身份失败。'; }); });
  // Plugin activation does not wait on external networking.
  setup = setup.then(restore).catch(() => { state = 'offline'; error = '恢复连接失败。'; });
  const dispose = () => { disposed = true; ++epoch; clearTimeout(changeTimer); engine?.close(); groups.dispose(); };
  process.once('disconnect', dispose); process.once('SIGTERM', dispose); process.parentPort?.once?.('close', dispose);
  return { dispose };
};
