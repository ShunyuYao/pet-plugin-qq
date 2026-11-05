'use strict';
const ORIGIN = 'https://api.bot.qq.com';
const SDK_VERSION = '1.0.5';
const USER_AGENT = `turitopia-qq-plugin/${require('../manifest.json').version} qqbot-nodejs/${SDK_VERSION}`;
function credentials(input) {
  const appId = String(input?.appId || '').trim();
  const appSecret = String(input?.appSecret || '').trim();
  if (!/^[1-9]\d{4,19}$/.test(appId)) throw Error('请输入官方机器人 AppID，不是普通 QQ 号。');
  if (!appSecret || appSecret.length > 256 || /\s/.test(appSecret)) throw Error('请在本机填写有效的 AppSecret。');
  return { appId, appSecret };
}
function safeSDKError(error) {
  // SDK errors may contain response bodies. Retain only numeric error codes.
  const known = /\b(100016|100007|10004|100001)\b/.exec(String(error?.message || ''))?.[1];
  const value = error?.safeCode ?? error?.bizCode ?? known ?? error?.httpStatus;
  const code = /^\d{1,12}$/.test(String(value)) ? String(value) : '';
  const hint = ({100016:'AppID 或 AppSecret 不正确',100007:'AppID 无效或机器人状态异常',10004:'机器人不存在',100001:'请求过于频繁，请稍后重试',40034005:'触发消息已过期',40034128:'被动回复时间或次数超限'})[code] || '请检查网络、机器人状态和权限；未知发送结果不会自动重发';
  const result = Error(`QQ 官方 SDK 请求未确认${code ? '（' + code + '）' : ''}：${hint}。`);
  result.safeCode = code; return result;
}
async function createSDKClients() {
  const { TokenManager, ApiClient } = await import('@tencent-connect/qqbot-nodejs/protocol');
  // No SDK logger: debug callbacks include session IDs and message bodies.
  return { tokens: new TokenManager({ baseUrl:ORIGIN, userAgent:USER_AGENT }),
    client: new ApiClient({ baseUrl:ORIGIN, userAgent:USER_AGENT, defaultTimeoutMs:10000 }) };
}
class OfficialAPI {
  constructor(config, { createClients = createSDKClients } = {}) {
    Object.assign(this, credentials(config), {createClients});
    this.closed = false; this.clientsPromise = null; this.loadedClients = null;
  }
  guard() { if (this.closed) throw Error('官方连接已停止。'); }
  async clients() {
    this.guard();
    const clients = await (this.clientsPromise ||= this.createClients()); this.loadedClients = clients;
    if (this.closed) { clients.tokens.stopBackgroundRefresh(this.appId); clients.tokens.clearCache(this.appId); this.guard(); }
    return clients;
  }
  async accessToken() {
    try { const {tokens} = await this.clients(); const token = await tokens.getAccessToken(this.appId, this.appSecret); this.guard(); return token; }
    catch (error) { throw safeSDKError(error); }
  }
  async request(path, {method = 'GET', body} = {}) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\r\n]/.test(path)) throw Error('官方 API 路径无效');
    try {
      const {client} = await this.clients(); const token = await this.accessToken();
      // Single request only: no withRetry or proactive fallback for replies.
      const data = await client.request(token, method, path, body, {timeoutMs:10000});
      this.guard(); return data;
    } catch (error) { throw safeSDKError(error); }
  }
  async startRefresh() {
    await this.accessToken(); const {tokens} = await this.clients(); this.guard();
    tokens.startBackgroundRefresh(this.appId, this.appSecret);
  }
  clearToken() { this.loadedClients?.tokens.clearCache(this.appId); }
  close() {
    this.closed = true; this.appSecret = '';
    this.loadedClients?.tokens.stopBackgroundRefresh(this.appId); this.loadedClients?.tokens.clearCache(this.appId);
  }
}
module.exports = {OfficialAPI, credentials, ORIGIN, SDK_VERSION, USER_AGENT, safeSDKError};
