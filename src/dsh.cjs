'use strict';
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');
function loopback(value, protocols) {
  const u = new URL(value);
  if (!protocols.includes(u.protocol) || !['127.0.0.1', 'localhost'].includes(u.hostname)
    || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw Error('只支持本机地址；远程服务请先建立本地端口转发。');
  return u;
}
const textParts = parts => (Array.isArray(parts) ? parts : []).filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
// DSH wire history omits materialized assistant messages; only visible text is projected.
function assistantText(data) {
  if (data.message?.content) return textParts(data.message.content);
  const blocks = new Map();
  for (const record of data.stream || []) {
    if (record.type === 'text-chunks') blocks.set(record.index, (blocks.get(record.index) || '') + record.texts.join(''));
    if (record.type === 'chunk') {
      const c = record.chunk;
      if (c.type === 'text-delta') blocks.set(c.index, (blocks.get(c.index) || '') + c.text);
      if (c.type === 'block-end' && c.block?.type === 'text') blocks.set(c.index, c.block.text);
    }
  }
  return [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join('\n');
}
class Dsh extends EventEmitter {
  constructor(config) { super(); this.config = config; this.base = loopback(config.dshUrl, ['http:', 'https:']); this.ready = false; this.records = new Map(); this.cookie = ''; this.closed = false; }
  async open() {
    this.closed = false;
    if (this.config.dshToken) {
      const auth = new URL(this.base); auth.searchParams.set('token', this.config.dshToken);
      const res = await fetch(auth, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
      this.cookie = res.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
      if (!this.cookie) throw Error('DSH 登录失败，请检查访问令牌。');
    }
    const url = new URL('/api/remote.mux', this.base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const streamId = randomUUID();
    const socket = this.socket = new WebSocket(url, { headers: this.cookie ? { cookie: this.cookie } : {}, maxPayload: 4 * 1024 * 1024, handshakeTimeout: 8000, followRedirects: false });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(Error('DSH 会话连接超时。')); socket.terminate(); }, 10000);
      const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
      socket.on('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: this.config.sessionId }, maxMessages: 60 } } } })));
      socket.on('message', raw => {
        try {
          const frame = JSON.parse(String(raw)); if (frame.streamId !== streamId) return;
          if (frame.type === 'error' || frame.type === 'end') throw Error('DSH 拒绝或结束了会话订阅。');
          if (frame.type !== 'item') return;
          const value = frame.value;
          if (value?.type === 'snapshot') {
            if (value.header?.id !== this.config.sessionId || !Number.isSafeInteger(value.cursor) || !Array.isArray(value.records)) throw Error('DSH 会话协议不兼容。');
            this.records.clear(); this.cursor = value.cursor; this.hasMore = value.hasMore === true;
            for (const row of value.records) this.accept(row, false);
            this.ready = true; finish(); this.emit('change');
          } else if (value?.type === 'event' && this.ready) {
            if (value.event.seq <= this.cursor) return;
            if (value.event.seq !== this.cursor + 1) throw Error('DSH 会话事件不连续，请重新连接。');
            this.cursor = value.event.seq; this.accept(value, true);
          }
        } catch { this.ready = false; finish(Error('DSH 会话协议异常，请重新连接。')); socket.terminate(); }
      });
      socket.on('error', () => { this.ready = false; finish(Error('DSH 连接失败。')); });
      socket.on('close', () => { this.ready = false; finish(Error('DSH 已断开。')); this.emit('offline'); });
    });
  }
  accept(row, live) {
    const event = row?.event;
    if (row?.type !== 'event' || !event || !Number.isSafeInteger(event.seq) || typeof event.type !== 'string' || !event.data) throw Error('invalid-history');
    this.records.set(event.seq, event);
    if (this.records.size > 6000) { this.records.delete(Math.min(...this.records.keys())); this.hasMore = true; }
    if (live) this.emit('change');
  }
  async rpc(method, request) {
    if (!this.ready) throw Error('DSH 未连接。');
    const rpcId = randomUUID();
    const res = await fetch(new URL('/api/' + method, this.base), { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request } } }), signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw Error('DSH 请求失败。');
    const raw = await res.text(); if (raw.length > 4 * 1024 * 1024) throw Error('DSH 返回过大。');
    const body = JSON.parse(raw);
    if (body.type !== 'server-response' || body.rpcId !== rpcId || body.result?.ok !== true) throw Error('DSH 拒绝请求或接口版本不兼容。');
    return body.result.value;
  }
  events() { return [...this.records.values()].sort((a, b) => a.seq - b.seq); }
  outcome(requestId) {
    const turns = new Map(); let active;
    for (const e of this.events()) {
      if (e.type === 'turn/start') { active = e.data.turn; turns.set(active, { ids: [], text: '', terminal: null }); }
      const entry = turns.get(e.data.turn ?? active); if (!entry) continue;
      if (e.type === 'user/message' && e.data.source?.rpcId) entry.ids.push(e.data.source.rpcId);
      if (e.type === 'assistant/message') entry.text += assistantText(e.data);
      if (e.type === 'turn/end') entry.terminal = e.data.reason?.kind;
    }
    const entry = [...turns.values()].find(t => t.ids.includes(requestId));
    return entry ? { found: true, foreign: entry.ids.some(id => id !== requestId), text: entry.text, terminal: entry.terminal }
      : { found: false, foreign: false, text: '', terminal: null };
  }
  messages() {
    const turns = new Map(); let turn;
    for (const e of this.events()) {
      if (e.type === 'turn/start') turn = e.data.turn;
      if (e.type === 'user/message' && e.data.source?.rpcId) turns.set(turn, e.data.source.rpcId);
    }
    return this.events().filter(e => ['user/message', 'assistant/message'].includes(e.type)).map(e => ({
      id: e.type === 'user/message' && e.data.source?.rpcId && !e.data.source.rpcId.startsWith('qq:') ? 'run-user-' + e.data.source.rpcId
        : e.type === 'assistant/message' && turns.get(e.data.turn) && !turns.get(e.data.turn).startsWith('qq:') ? 'run-pet-' + turns.get(e.data.turn)
          : 'dsh:' + this.config.sessionId + ':' + e.seq, role: e.type === 'user/message' ? 'user' : 'assistant',
      content: e.type === 'user/message' ? textParts(e.data.content) : assistantText(e.data), createdAt: new Date(e.time).toISOString(),
    })).filter(m => m.content.trim());
  }
  async history(page = 0, pageSize = 30) {
    if (!this.ready) throw Error('DSH 未连接。');
    // Bounded backwards reads; no private database access and no copied local memory.
    for (let n = 0; n < 4 && this.hasMore && this.messages().length < (page + 1) * pageSize; n++) {
      const beforeSeq = Math.min(...this.records.keys());
      const value = await this.rpc('session/page', { address: { kind: 'session', sessionId: this.config.sessionId }, throughSeq: this.cursor, beforeSeq, maxMessages: 60 });
      if (!Array.isArray(value?.records)) throw Error('DSH 历史协议不兼容。');
      this.hasMore = value.hasMore === true;
      for (const row of value.records) this.accept(row, false);
      if (!value.records.length || Math.min(...this.records.keys()) >= beforeSeq) break;
    }
    const all = this.messages(); const end = Math.max(0, all.length - page * pageSize); const start = Math.max(0, end - pageSize);
    return { messages: all.slice(start, end).map(m => ({ ...m, content: m.content.slice(0, 16000) })), page, hasMore: start > 0 || this.hasMore };
  }
  prompt(requestId, text) { return this.rpc('session/prompt', { sessionId: this.config.sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] }); }
  close() { this.closed = true; this.ready = false; this.socket?.terminate(); this.cookie = ''; }
}
module.exports = { Dsh, loopback, assistantText };
