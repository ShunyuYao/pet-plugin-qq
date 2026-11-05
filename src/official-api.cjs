'use strict';
const ORIGIN = 'https://api.bot.qq.com';
function credentials(input) {
  const appId = String(input?.appId || '').trim();
  const appSecret = String(input?.appSecret || '').trim();
  if (!/^[1-9]\d{4,19}$/.test(appId)) throw Error('请输入官方机器人 AppID，不是普通 QQ 号。');
  if (!appSecret || appSecret.length > 256 || /\s/.test(appSecret)) throw Error('请在本机填写有效的 AppSecret。');
  return { appId, appSecret };
}
class OfficialAPI {
  constructor(config, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    Object.assign(this, credentials(config), { fetchImpl, now });
    this.token = null; this.expiresAt = 0; this.refreshing = null; this.controller = new AbortController();
  }
  async request(path, { method = 'GET', body, auth = true } = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) throw Error('官方 API 路径无效');
    this.controller.signal.throwIfAborted();
    const token = auth ? await this.accessToken() : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'QQBot ' + token;
    let response, data;
    try {
      response = await this.fetchImpl(ORIGIN + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10000)]) });
      data = await response.json();
    } catch { throw Error('QQ 官方接口请求未确认，请检查网络；系统不会自动重发。'); }
    this.controller.signal.throwIfAborted();
    if (!response.ok || (data?.code !== undefined && Number(data.code) !== 0)) {
      // Never forward server message/body: either may echo credentials/content.
      const code = String(data?.code || response.status).replace(/[^\d-]/g, '').slice(0, 20);
      const hint = ({100016:'AppID 或 AppSecret 不正确',100007:'AppID 无效或机器人状态异常',10004:'机器人不存在',100001:'请求过于频繁，请稍后手动重试',4014:'没有事件订阅权限',40034105:'群未授权机器人主动发言',40034005:'触发消息已超过回复时限',40034128:'被动回复时间或次数超限'})[code] || '请核对机器人状态与权限';
      throw Error(`QQ 官方接口错误 ${code}：${hint}。`);
    }
    if (!data || typeof data !== 'object') throw Error('QQ 官方接口响应格式无效');
    return data;
  }
  async accessToken() {
    if (this.token && this.now() < this.expiresAt - 45000) return this.token;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const result = await this.request('/app/getAppAccessToken', { method: 'POST', auth: false, body: { appId: this.appId, clientSecret: this.appSecret } });
      const ttl = Number(result.expires_in);
      if (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(ttl) || ttl <= 0) throw Error('官方访问凭证响应无效');
      this.token = result.access_token; this.expiresAt = this.now() + ttl * 1000; return this.token;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  close() { this.controller.abort(); this.token = null; this.appSecret = ''; }
}
module.exports = { OfficialAPI, credentials, ORIGIN };
