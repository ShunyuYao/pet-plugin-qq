'use strict';
const { Dsh, loopback } = require('./dsh.cjs');
const { OneBot } = require('./onebot.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function validateConfig(input) {
  const c = Object.fromEntries(['dshUrl', 'dshToken', 'qqUrl', 'qqToken', 'sessionId', 'ownerQQ', 'botQQ'].map(k => [k, String(input?.[k] || '').trim()]));
  loopback(c.dshUrl, ['http:', 'https:']); loopback(c.qqUrl, ['ws:', 'wss:']);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(c.sessionId)) throw Error('请填写已有 DSH 会话 ID。');
  if (![c.ownerQQ, c.botQQ].every(v => /^[1-9]\d{4,12}$/.test(v)) || c.ownerQQ === c.botQQ) throw Error('主人 QQ 与机器人 QQ 必须不同。');
  if ([c.dshToken, c.qqToken].some(v => v.length > 4096 || /[\r\n]/.test(v))) throw Error('访问令牌格式无效。');
  if (input.exclusive !== true) throw Error('请先确认已停止旧桥接对该会话的收发。');
  return c;
}
class Engine {
  constructor({ config, ledger, save, changed, current }) {
    this.config = config; this.ledger = ledger || {}; this.save = save; this.changed = changed; this.current = current;
    this.dsh = new Dsh(config); this.qq = new OneBot(config); this.queue = []; this.disposed = false; this.draining = false; this.serial = Promise.resolve();
    for (const row of Object.values(this.ledger)) if (['queued', 'running', 'sending'].includes(row.status)) { row.status = 'unknown'; row.error = '上次操作被中断；请核对原会话与 QQ，不会自动重放。'; }
    this.dsh.on('change', () => { if (!this.disposed) this.changed(); });
    this.qq.on('message', m => { this.submit('qq:' + config.botQQ + ':' + m.id, m.text, 'qq').catch(() => {}); });
  }
  async open() { await this.save(this.ledger); await this.dsh.open(); if (this.disposed) throw Error('连接已停止。'); await this.qq.open(); }
  async guard() { if (this.disposed || !await this.current()) throw Error('宠物身份已改变，请重新连接。'); }
  submit(id, text, source = 'desktop') {
    const op = this.serial.then(async () => {
      await this.guard();
      if (typeof id !== 'string' || id.length > 180 || !/^[a-zA-Z0-9:_-]+$/.test(id) || typeof text !== 'string' || !text.trim() || text.length > 8000) throw Error('消息格式无效。');
      if (['__proto__', 'constructor', 'prototype'].includes(id)) throw Error('请求 ID 无效。');
      const old = Object.hasOwn(this.ledger, id) ? this.ledger[id] : null;
      if (old) { if (old.text !== text || old.source !== source) throw Error('请求 ID 已被其他消息使用。'); return { accepted: true }; }
      if (!this.dsh.ready || !this.qq.ready) throw Error('连接未就绪，请先重连。');
      if (this.queue.length >= 20) throw Error('消息队列已满。');
      for (const [key, row] of Object.entries(this.ledger)) if (Date.now() - row.at > 86400000 && !['queued', 'running', 'sending'].includes(row.status)) delete this.ledger[key];
      if (Object.keys(this.ledger).length >= 1000) throw Error('今日消息账本已满。');
      this.ledger[id] = { id, text, source, status: 'queued', at: Date.now(), reply: '' };
      try { await this.save(this.ledger); } catch (error) { delete this.ledger[id]; throw error; }
      this.queue.push(id); void this.drain(); return { accepted: true };
    });
    this.serial = op.catch(() => {}); return op;
  }
  async drain() {
    if (this.draining) return; this.draining = true;
    try {
      while (this.queue.length && !this.disposed) {
        const row = this.ledger[this.queue.shift()]; if (row.status !== 'queued') continue;
        try {
          await this.guard();
          // Exclusive bridge ownership is also checked against an already running turn.
          const events = this.dsh.events();
          const lastStart = events.findLast(e => e.type === 'turn/start');
          if (lastStart && !events.some(e => e.type === 'turn/end' && e.data.turn === lastStart.data.turn)) throw Error('原会话正在运行，请等它完成后再发送。');
          row.status = 'running'; await this.save(this.ledger);
          await this.guard(); await this.dsh.prompt(row.id, row.text);
          const deadline = Date.now() + 10 * 60 * 1000;
          let outcome;
          while (Date.now() < deadline) {
            await this.guard();
            if (!this.dsh.ready) throw Error('DSH 已断开，提交结果待核对。');
            outcome = this.dsh.outcome(row.id);
            if (outcome.terminal) break;
            await sleep(200);
          }
          if (!outcome?.terminal) throw Error('等待超时，请到 DSH 检查是否需要工具审批。');
          if (row.status === 'cancelled') continue;
          if (outcome.foreign || outcome.terminal !== 'completed' || !outcome.text.trim()) throw Error('原会话未正常完成，或混入其他入口的输入，请在 DSH 检查。');
          row.reply = outcome.text.slice(0, 16000);
          if (row.source === 'qq') {
            row.status = 'sending'; await this.save(this.ledger); await this.guard();
            row.receipt = await this.qq.send(row.reply);
          }
          row.status = 'completed';
        } catch (error) {
          if (row.status !== 'cancelled') { row.error = error.message; row.status = ['running', 'sending'].includes(row.status) ? 'unknown' : 'failed'; }
        } finally {
          try { await this.save(this.ledger); } catch { this.close(); }
          this.changed();
        }
      }
    } finally { this.draining = false; }
  }
  poll(id) {
    const row = this.ledger[id];
    return row ? { status: row.status === 'unknown' ? 'failed' : row.status, text: row.reply, error: row.error || '' } : { status: 'failed', error: '请求不存在。' };
  }
  async cancel(id) {
    const row = this.ledger[id]; if (!row || !['queued', 'running'].includes(row.status)) return false;
    // DSH 0.2.1 cancellation is session-wide. Never cancel a foreign turn.
    row.status = 'cancelled'; row.error = '已停止等待与结果投递；已提交的 DSH 回合可能继续执行。'; await this.save(this.ledger); return true;
  }
  status() { return { dsh: this.dsh.ready, qq: this.qq.ready, jobs: Object.values(this.ledger).slice(-10).reverse().map(({ id, source, status, error, at }) => ({ id, source, status, error: error || '', at })) }; }
  close() { this.disposed = true; this.dsh.close(); this.qq.close(); }
}
module.exports = { Engine, validateConfig };
