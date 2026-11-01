'use strict';
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const { loopback } = require('./dsh.cjs');
class OneBot extends EventEmitter {
  constructor(config) { super(); this.config = config; this.pending = new Map(); this.ready = false; }
  async open() {
    const url = loopback(this.config.qqUrl, ['ws:', 'wss:']);
    this.socket = new WebSocket(url, { headers: this.config.qqToken ? { Authorization: 'Bearer ' + this.config.qqToken } : {}, handshakeTimeout: 8000, maxPayload: 1024 * 1024, followRedirects: false });
    this.socket.on('message', raw => {
      try {
        const m = JSON.parse(String(raw));
        if (m.echo && this.pending.has(m.echo)) { this.pending.get(m.echo)(m); return; }
        if (!this.ready || m.post_type !== 'message' || m.message_type !== 'private' || m.sub_type !== 'friend'
          || String(m.self_id) !== this.config.botQQ || String(m.user_id) !== this.config.ownerQQ || String(m.user_id) === String(m.self_id)) return;
        // Array messages only: reject CQ codes, images, and embedded at/forward segments in v1.
        if (!Array.isArray(m.message) || !m.message.length || m.message.some(p => p.type !== 'text' || typeof p.data?.text !== 'string')) return;
        const text = m.message.map(p => p.data.text).join('').trim();
        if (!text || text.length > 8000 || !['string', 'number'].includes(typeof m.message_id)) return;
        if (!Number.isFinite(m.time) || Math.abs(Date.now() / 1000 - m.time) > 300) return;
        this.emit('message', { id: String(m.message_id), text });
      } catch { /* Malformed frames never create a model turn. */ }
    });
    this.socket.on('error', () => {});
    this.socket.on('close', () => { this.ready = false; for (const finish of [...this.pending.values()]) finish(null); this.emit('offline'); });
    await new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', () => reject(Error('NapCat 连接失败。'))); this.socket.once('close', () => reject(Error('NapCat 已断开。'))); });
    const identity = await this.call('get_login_info', {});
    if (String(identity.user_id) !== this.config.botQQ) { this.close(); throw Error('NapCat 登录 QQ 与配置不一致。'); }
    this.ready = true;
  }
  call(action, params) {
    return new Promise((resolve, reject) => {
      const echo = randomUUID();
      const timer = setTimeout(() => finish(null), 8000);
      const finish = value => {
        clearTimeout(timer); this.pending.delete(echo);
        if (value?.status === 'ok' && value.retcode === 0) resolve(value.data); else reject(Error('QQ 操作未确认，请在 QQ 检查，系统不会自动重发。'));
      };
      this.pending.set(echo, finish);
      if (this.socket?.readyState !== WebSocket.OPEN) { finish(null); return; }
      this.socket.send(JSON.stringify({ action, params, echo }), error => { if (error) finish(null); });
    });
  }
  async send(text) {
    if (!this.ready) throw Error('QQ 未连接。');
    const receipt = await this.call('send_private_msg', { user_id: Number(this.config.ownerQQ), message: [{ type: 'text', data: { text } }] });
    if (!['number', 'string'].includes(typeof receipt?.message_id)) throw Error('QQ 发送回执无效。');
    return String(receipt.message_id);
  }
  close() { this.ready = false; this.socket?.terminate(); for (const finish of [...this.pending.values()]) finish(null); }
}
module.exports = { OneBot };
