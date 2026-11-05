'use strict';
const {EventEmitter} = require('node:events');
const {OfficialAPI, SDK_VERSION, USER_AGENT} = require('./official-api.cjs');
const openId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
function gatewayURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'wss:' || !['api.bot.qq.com','api.sgroup.qq.com'].includes(url.hostname) || url.port || url.username || url.password) throw Error('官方返回的网关地址不在允许范围。');
  return url.href;
}
async function createSDKGateway(options) {
  const {GatewayConnection} = await import('@tencent-connect/qqbot-nodejs/protocol');
  return new GatewayConnection(options);
}
class OfficialBot extends EventEmitter {
  constructor(config, {api, gatewayFactory = createSDKGateway, now = Date.now, startupTimeoutMs = 12000} = {}) {
    super(); Object.assign(this, {config, api:api || new OfficialAPI(config), gatewayFactory, now, startupTimeoutMs});
    this.ready = false; this.closed = false; this.identity = null; this.sends = new Set(); this.controller = new AbortController();
    this.receiving = {transport:'tencent-sdk', sdkVersion:SDK_VERSION, state:'idle', startedAt:now(), dispatches:0, groupMessages:0,
      allowedGroupMessages:0, ignoredGroupMessages:0, fullMessages:0, atMessages:0, privateMessages:0, lastPrivateAt:null,
      reconnects:0, connectedCount:0, lastConnectedAt:null, heartbeatManagedBySDK:true, lastEventAt:null, lastEventType:null, lastMessageShape:null};
  }
  async open() {
    if (this.closed) throw Error('官方连接已停止。');
    this.receiving.state = 'connecting';
    const initial = new Promise((resolve, reject) => {
      let settled = false;
      this.finishOpen = error => { if (settled) return; settled = true; clearTimeout(this.openTimer); error ? reject(error) : resolve(); };
      this.openTimer = setTimeout(() => { this.finishOpen(Error('腾讯 SDK 初次连接超时，请核对网络与机器人配置。')); this.close(); }, this.startupTimeoutMs);
    });
    void initial.catch(() => {});
    const connected = data => {
      if (this.closed) return;
      const resumed = this.receiving.connectedCount > 0;
      if (data?.user?.id) this.identity = String(data.user.id);
      this.ready = true; this.receiving.state = 'ready'; this.receiving.connectedCount++; this.receiving.lastConnectedAt = this.now();
      this.receiving.dispatches++; this.receiving.lastEventType = resumed ? 'RESUMED' : 'READY'; this.receiving.lastEventAt = this.now();
      this.finishOpen(); if (resumed) this.emit('reconnected');
    };
    try {
      await Promise.race([this.api.startRefresh(), initial]);
      if (this.closed) throw Error('官方连接已停止。');
      const options = {
        account:{accountId:'official-' + this.config.appId, appId:this.config.appId, clientSecret:this.config.appSecret},
        abortSignal:this.controller.signal, userAgent:USER_AGENT, intents:1 << 25,
        reconnect:{maxAttempts:3}, handshakeTimeoutMs:10000,
        getAccessToken:() => this.api.accessToken(), clearTokenCache:() => this.api.clearToken(),
        getGatewayUrl:async () => gatewayURL((await this.api.request('/gateway')).url),
        onReady:connected, onResumed:connected,
        onDisconnected:event => {
          if (this.closed) return;
          this.ready = false; this.receiving.state = event.willReconnect ? 'reconnecting' : 'offline';
          if (event.willReconnect) { this.receiving.reconnects++; this.emit('reconnecting'); }
        },
        onError:() => {},
        onMessage:msg => this.message(msg), onRawEvent:(type, data) => this.rawEvent(type, data),
      };
      this.connection = await Promise.race([this.gatewayFactory(options), initial]);
      if (this.closed) throw Error('官方连接已停止。');
      this.running = Promise.resolve(this.connection.start()).then(() => {
        if (!this.closed) throw Error('腾讯 SDK 连接意外结束。');
      }).catch(error => {
        if (this.closed) return;
        const code = ['GATEWAY_FATAL_CLOSE','GATEWAY_RETRY_EXHAUSTED'].includes(error?.code) ? `（${error.code}）` : '';
        const message = '腾讯 SDK 连接已停止' + code + '，请核对后手动恢复。';
        const connectedBefore = this.receiving.connectedCount > 0;
        this.finishOpen(Error(message)); this.close(); this.receiving.state = 'offline';
        if (connectedBefore) this.emit('offline', message);
      });
      await initial;
    } catch (error) { this.finishOpen(error); this.close(); throw error; }
  }
  observe(type) {
    this.receiving.dispatches++; this.receiving.lastEventAt = this.now();
    this.receiving.lastEventType = typeof type === 'string' && /^[A-Z_]{1,64}$/.test(type) ? type : 'unknown';
  }
  message(msg) {
    if (this.closed || !this.ready) return;
    this.observe(msg.rawEventType);
    if (msg.kind === 'c2c') {
      this.receiving.privateMessages++; this.receiving.lastPrivateAt = this.now();
      // A private session must explicitly pin one owner. Group/discovery mode
      // remains receipt-count-only and never receives private content.
      if (this.config.privateOwnerOpenId && msg.senderId === this.config.privateOwnerOpenId && msg.raw?.author?.bot !== true) {
        this.emit('private-event', {messageId:msg.messageId,senderId:msg.senderId,occurredAt:Date.parse(msg.timestamp),text:msg.content});
      }
      return;
    }
    if (msg.kind !== 'group') return;
    this.receiving.groupMessages++;
    if (msg.rawEventType === 'GROUP_MESSAGE_CREATE') this.receiving.fullMessages++; else this.receiving.atMessages++;
    const data = msg.raw, allowed = this.config.groupIds?.includes(msg.groupOpenid) === true;
    if (allowed) this.receiving.allowedGroupMessages++; else this.receiving.ignoredGroupMessages++;
    this.receiving.lastMessageShape = {idType:typeof data?.id, timestampType:typeof data?.timestamp,
      timestampParses:Number.isFinite(Date.parse(data?.timestamp)), groupOpenIdType:typeof data?.group_openid,
      idFormatValid:typeof data?.id === 'string' && /^[A-Za-z0-9_.=+/-]{1,512}$/.test(data.id), allowedGroup:allowed};
    if (!openId(msg.groupOpenid)) return;
    this.emit('group-seen', {groupId:msg.groupOpenid,eventType:msg.rawEventType,at:this.now()});
    if (allowed) this.emit('group-event', {op:0,t:msg.rawEventType,d:data,botIdentity:this.identity});
  }
  rawEvent(type, data) {
    if (this.closed || !this.ready) return;
    this.observe(type); const groupId = data?.group_openid;
    if (!openId(groupId) || !['GROUP_ADD_ROBOT','GROUP_DEL_ROBOT'].includes(type)) return;
    this.emit('group-seen', {groupId,eventType:type,at:this.now()});
    if (type === 'GROUP_DEL_ROBOT' && this.config.groupIds?.includes(groupId)) {
      this.close(); this.emit('offline', '机器人已被移出授权群，请核对群权限。');
    }
  }
  diagnostics() { return structuredClone(this.receiving); }
  async sendPrivate(owner, text, trigger) {
    if (!this.ready || this.closed || owner !== this.config.privateOwnerOpenId || trigger?.senderId !== owner) throw Error('无权回复这个私聊用户。');
    if (typeof trigger.messageId !== 'string' || !trigger.messageId || !Number.isFinite(trigger.occurredAt) || this.now()-trigger.occurredAt>=300000 || trigger.occurredAt>this.now()+60000) throw Error('私聊触发消息无效或已过期。');
    if (typeof text !== 'string' || !text.trim() || text.length>1000) throw Error('私聊回复无效。');
    const key='c2c:'+owner+':'+trigger.messageId;
    if(this.sends.has(key)||this.sends.size>=50000)throw Error('私聊已尝试回复或发送账本已满，不自动重发。');
    this.sends.add(key);
    const receipt=await this.api.request('/v2/users/'+encodeURIComponent(owner)+'/messages',{method:'POST',body:{msg_type:0,content:text,msg_id:trigger.messageId,msg_seq:1}});
    if(typeof receipt?.id!=='string'||!receipt.id)throw Error('私聊发送回执未知，不自动重发。');
    return receipt.id;
  }
  async sendGroup(groupId, text, trigger) {
    if (!this.ready || this.closed || !this.config.groupIds?.includes(groupId)) throw Error('无权向这个官方机器人群发送消息。');
    if (!trigger || trigger.groupId !== groupId || typeof trigger.messageId !== 'string' || !Number.isFinite(trigger.occurredAt) || this.now() - trigger.occurredAt >= 5 * 60000 || trigger.occurredAt > this.now() + 60000) throw Error('官方群回复缺少有效触发消息，或已超过5分钟。');
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw Error('群回复内容无效');
    const key = groupId + ':' + trigger.messageId;
    if (this.sends.has(key)) throw Error('这条消息已尝试回复，结果不确定时不会重发。');
    if (this.sends.size >= 50000) throw Error('发送账本已满，请暂停并核对后重连。');
    this.sends.add(key);
    const receipt = await this.api.request('/v2/groups/' + encodeURIComponent(groupId) + '/messages', {method:'POST',body:{msg_type:0,content:text,msg_id:trigger.messageId,msg_seq:1}});
    if (typeof receipt?.id !== 'string' || !receipt.id) throw Error('官方群发送回执未知，不自动重发。');
    return receipt.id;
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.ready = false; this.receiving.state = 'stopped';
    clearTimeout(this.openTimer); this.finishOpen?.(Error('官方连接已停止。'));
    this.controller.abort(); this.api.close();
  }
}
module.exports = {OfficialBot, openId, gatewayURL, createSDKGateway};
