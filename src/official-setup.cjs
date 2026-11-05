'use strict';
const { createHash } = require('node:crypto');
const { credentials } = require('./official-api.cjs');
const { OfficialBot } = require('./official-bot.cjs');
class OfficialSetup {
  constructor(pet, { makeBot = config => new OfficialBot(config) } = {}) {
    this.pet = pet; this.makeBot = makeBot; this.generation = 0; this.state = 'idle'; this.error = ''; this.groups = new Map(); this.bot = null;
  }
  key(scope) { return 'official.setup.v1.' + createHash('sha256').update(scope.scopeId).digest('hex'); }
  async same(scope, generation) {
    const actual = await this.pet.profile.getScope();
    return generation === this.generation && actual.scopeId === scope.scopeId && actual.revision === scope.revision;
  }
  stop() { ++this.generation; this.bot?.close(); this.bot = null; this.scope = null; this.state = 'idle'; this.groups.clear(); this.error = ''; }
  async saved(scope) { return await this.pet.secrets.get(this.key(scope)); }
  async prepare(input) {
    if (this.bot && ['connecting','ready','reconnecting'].includes(this.state)) throw Error('官方连接正在建立或已在线；请先停止发现，再更换密钥或重新验证。');
    this.stop(); const generation = this.generation, scope = await this.pet.profile.getScope();
    const previous = await this.saved(scope);
    const config = credentials({ appId: input?.appId, appSecret: input?.appSecret || (previous?.appId === input?.appId ? previous.appSecret : '') });
    if (!await this.same(scope, generation)) throw Error('宠物身份已改变');
    await this.pet.secrets.set(this.key(scope), config);
    if (!await this.same(scope, generation)) throw Error('宠物身份已改变');
    this.scope = scope;
    const bot = this.bot = this.makeBot({ ...config, provider: 'official', groupIds: [] });
    this.state = 'connecting'; this.error = '';
    bot.on('group-seen', data => {
      void (async () => {
        if (!await this.same(scope, generation)) return;
        if (data.eventType === 'GROUP_DEL_ROBOT') this.groups.delete(data.groupId);
        else if (this.groups.has(data.groupId) || this.groups.size < 20) {
          const previous = this.groups.get(data.groupId);
          this.groups.set(data.groupId, { groupId: data.groupId, at: data.at, fullMessagesObserved: data.eventType === 'GROUP_MESSAGE_CREATE' || previous?.fullMessagesObserved === true });
        }
      })().catch(() => {});
    });
    bot.on('offline', message => { if (generation === this.generation) { this.state = 'offline'; this.error = message || '官方连接已断开，请手动重试'; } });
    bot.on('reconnecting', () => { if (generation === this.generation) { this.state='reconnecting'; this.error='腾讯 SDK 正在恢复连接'; } });
    bot.on('reconnected', () => { if (generation === this.generation) { this.state='ready'; this.error=''; } });
    // SDK calls have a 15-second envelope; do not block it on network handshake.
    this.pending = bot.open().then(async () => {
      if (await this.same(scope, generation)) this.state = 'ready'; else bot.close();
    }).catch(error => {
      if (generation === this.generation) { this.state = 'offline'; this.error = error.message; }
      bot.close();
    });
    return { accepted: true };
  }
  async status() {
    const scope = await this.pet.profile.getScope(), saved = await this.saved(scope);
    if (this.scope && (this.scope.scopeId !== scope.scopeId || this.scope.revision !== scope.revision)) this.stop();
    return { state: this.state, error: this.error, appId: saved?.appId || '', hasSecret: !!saved?.appSecret, groups: [...this.groups.values()], diagnostics:this.bot?.diagnostics?.()||null };
  }
  async connection(input) {
    const scope = await this.pet.profile.getScope(), saved = await this.saved(scope);
    const config = credentials({ appId: input?.appId, appSecret: input?.appSecret || (saved?.appId === input?.appId ? saved.appSecret : '') });
    this.stop(); return { ...input, ...config };
  }
}
module.exports = { OfficialSetup };
