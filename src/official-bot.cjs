'use strict';
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { OfficialAPI } = require('./official-api.cjs');
const openId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
function gatewayURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'wss:' || !['api.bot.qq.com','api.sgroup.qq.com'].includes(url.hostname) || url.port || url.username || url.password) throw Error('官方返回的网关地址不在允许范围。');
  return url.href;
}
class OfficialBot extends EventEmitter {
  constructor(config, { api, socketFactory = url => new WebSocket(url, { handshakeTimeout: 10000, maxPayload: 256 * 1024, followRedirects: false }), now = Date.now } = {}) {
    super(); Object.assign(this, { config, api: api || new OfficialAPI(config), socketFactory, now });
    this.ready = false; this.closed = false; this.sequence = null; this.identity = null; this.awaitingAck = false; this.sends = new Set();
    this.receiving = { startedAt:now(), dispatches:0, groupMessages:0, allowedGroupMessages:0, ignoredGroupMessages:0, fullMessages:0, atMessages:0, heartbeatAcks:0, lastHeartbeatAt:null, lastEventAt:null, lastEventType:null, lastMessageShape:null };
  }
  async open() {
    const token = await this.api.accessToken();
    const gateway = await this.api.request('/gateway');
    if (this.closed) throw Error('官方连接已取消。');
    const socket = this.socket = this.socketFactory(gatewayURL(gateway.url));
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(Error('QQ 官方网关鉴权超时，请核对连接方式、权限和网络。')), 12000);
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); this.cancelOpen = null; if (error) { this.close(); reject(error); } else resolve(); };
      this.cancelOpen = () => finish(Error('官方连接已停止。'));
      const offline = message => { const wasReady = this.ready; finish(Error(message)); this.close(); if (wasReady) this.emit('offline', message); };
      socket.on('error', () => offline('QQ 官方网关网络错误，请手动重连。'));
      socket.on('close', code => offline(`QQ 官方网关已断开（${Number(code) || 0}），请核对后手动重连。`));
      socket.on('message', raw => {
        if (this.closed) return;
        try {
          const event = JSON.parse(String(raw));
          if (event.op === 0) {
            this.receiving.dispatches++;
            this.receiving.lastEventAt = this.now();
            this.receiving.lastEventType = typeof event.t === 'string' && /^[A-Z_]{1,64}$/.test(event.t) ? event.t : 'unknown';
            if (['GROUP_MESSAGE_CREATE','GROUP_AT_MESSAGE_CREATE'].includes(event.t)) {
              this.receiving.groupMessages++;
              if (event.t === 'GROUP_MESSAGE_CREATE') this.receiving.fullMessages++; else this.receiving.atMessages++;
              const allowed = this.config.groupIds?.includes(event.d?.group_openid) === true;
              if (allowed) this.receiving.allowedGroupMessages++; else this.receiving.ignoredGroupMessages++;
              // Types/counts only: no body, sender, message ID, group ID or token.
              this.receiving.lastMessageShape = { idType:typeof event.d?.id, timestampType:typeof event.d?.timestamp,
                timestampParses:Number.isFinite(Date.parse(event.d?.timestamp)), groupOpenIdType:typeof event.d?.group_openid,
                idFormatValid:typeof event.d?.id === 'string' && /^[A-Za-z0-9_.=+/-]{1,512}$/.test(event.d.id), allowedGroup:allowed };
            }
          }
          if (Number.isSafeInteger(event.s)) this.sequence = event.s;
          if (event.op === 10) {
            if (this.heartbeat) return offline('QQ 官方网关重复握手，连接已停止。');
            const interval = event.d?.heartbeat_interval;
            if (!Number.isInteger(interval) || interval < 1000 || interval > 300000) return offline('官方心跳参数无效。');
            socket.send(JSON.stringify({ op: 2, d: { token: 'QQBot ' + token, intents: 1 << 25, shard: [0, 1], properties: {} } }));
            this.heartbeat = setInterval(() => {
              if (this.awaitingAck) return offline('QQ 官方网关心跳未确认，连接已停止。');
              this.awaitingAck = true; this.sendHeartbeat();
            }, interval); this.heartbeat.unref?.();
          } else if (event.op === 11) { this.awaitingAck = false; this.receiving.heartbeatAcks++; this.receiving.lastHeartbeatAt=this.now(); }
          else if (event.op === 1) this.sendHeartbeat();
          else if (event.op === 7) offline('QQ 官方网关要求重建连接（OpCode 7），请手动重连。');
          else if (event.op === 9) offline('QQ 官方网关拒绝当前会话鉴权（OpCode 9），请确认没有其他程序同时连接该机器人，稍后手动重连。');
          else if (event.op === 0 && event.t === 'READY') {
            if (this.ready) return;
            if (!event.d?.user?.id || !event.d?.session_id) return offline('官方机器人身份响应无效。');
            this.identity = String(event.d.user.id); this.ready = true; finish();
            this.refreshTimer = setInterval(() => { void this.api.accessToken().catch(() => offline('官方访问凭证刷新失败，请手动重连。')); }, 30000); this.refreshTimer.unref?.();
          } else if (event.op === 0 && this.ready) {
            const groupId = event.d?.group_openid;
            if (!openId(groupId)) return;
            if (['GROUP_ADD_ROBOT', 'GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'GROUP_DEL_ROBOT'].includes(event.t)) {
              this.emit('group-seen', { groupId, eventType: event.t, at: this.now() });
            }
            if (event.t === 'GROUP_DEL_ROBOT' && this.config.groupIds?.includes(groupId)) return offline('机器人已被移出授权群，请核对群权限。');
            if (['GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'].includes(event.t) && this.config.groupIds?.includes(groupId)) {
              this.emit('group-event', { ...event, botIdentity: this.identity });
            }
          }
        } catch { offline('QQ 官方事件处理失败，已停止连接，请核对缺失区间。'); }
      });
    });
  }
  diagnostics() { return structuredClone(this.receiving); }
  sendHeartbeat() { if (!this.closed && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ op: 1, d: this.sequence })); }
  async sendGroup(groupId, text, trigger) {
    if (!this.ready || !this.config.groupIds?.includes(groupId)) throw Error('无权向这个官方机器人群发送消息。');
    if (!trigger || trigger.groupId !== groupId || typeof trigger.messageId !== 'string' || !Number.isFinite(trigger.occurredAt) || this.now() - trigger.occurredAt >= 5 * 60000 || trigger.occurredAt > this.now() + 60000) throw Error('官方群回复缺少有效触发消息，或已超过5分钟。');
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw Error('群回复内容无效');
    const key = groupId + ':' + trigger.messageId;
    if (this.sends.has(key)) throw Error('这条消息已尝试回复，结果不确定时不会重发。');
    if (this.sends.size >= 50000) throw Error('发送账本已满，请暂停并核对后重连。');
    this.sends.add(key);
    const receipt = await this.api.request('/v2/groups/' + encodeURIComponent(groupId) + '/messages', { method: 'POST', body: { msg_type: 0, content: text, msg_id: trigger.messageId, msg_seq: 1 } });
    if (typeof receipt.id !== 'string' || !receipt.id) throw Error('官方群发送回执未知，不自动重发。');
    return receipt.id;
  }
  close() {
    this.closed = true; this.ready = false; clearInterval(this.heartbeat); clearInterval(this.refreshTimer);
    const cancel = this.cancelOpen; this.cancelOpen = null; cancel?.(); this.socket?.terminate(); this.api.close();
  }
}
module.exports = { OfficialBot, openId, gatewayURL };
