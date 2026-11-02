'use strict';
const { OneBot } = require('./onebot.cjs');
const { normalizeGroupEvent } = require('./group-events.cjs');
class GroupCollector {
  constructor({ config, store, current, now = Date.now }) {
    Object.assign(this, { config, store, current, now });
    this.qq = null; this.serial = Promise.resolve(); this.generation = 0; this.state = 'disconnected'; this.error = ''; this.pending = 0;
  }
  async guard(generation) {
    if (generation !== this.generation || !await this.current()) throw Error('群采集身份或连接已改变。');
  }
  async open() {
    this.stop(); const generation = this.generation; this.state = 'connecting'; this.error = '';
    try {
      await this.guard(generation);
      // An unclosed last interval is not evidence of continuous availability.
      await this.store.interval('offline', 'connection-start');
      const qq = this.qq = new OneBot(this.config);
      qq.on('group-event', raw => this.enqueue(raw, generation));
      qq.on('offline', () => { if (generation === this.generation) this.fail('QQ 已断开，离线消息未采集。'); });
      await qq.open(); await this.guard(generation);
      await this.store.interval('online', 'connected'); this.state = 'collecting';
      this.timer = setInterval(() => {
        this.serial = this.serial.then(async () => { await this.guard(generation); await this.store.maintenance(); }).catch(() => this.fail('群数据维护失败或身份已改变，请核对后重连。'));
      }, 60000); this.timer.unref?.();
    } catch (error) { if (generation === this.generation) this.fail(error.message); throw error; }
  }
  enqueue(raw, generation) {
    if (generation !== this.generation || !['collecting', 'connecting'].includes(this.state)) return;
    if (this.pending >= 200) { this.fail('群事件积压超限，已停止采集；请核对缺失区间。'); return; }
    this.pending++;
    this.serial = this.serial.then(async () => {
      if (generation !== this.generation) return;
      await this.guard(generation);
      const event = normalizeGroupEvent(raw, this.config, this.now());
      if (event) { await this.store.append(event); await this.guard(generation); }
    }).catch(error => { if (generation === this.generation) this.fail(error.message); }).finally(() => { this.pending--; });
  }
  stop() { ++this.generation; clearInterval(this.timer); this.qq?.close(); this.qq = null; }
  fail(message) {
    this.stop(); this.state = 'offline'; this.error = message;
    this.serial = this.serial.then(() => this.store.interval('offline', 'error')).catch(() => {});
  }
  async pause() { this.stop(); this.state = 'paused'; await this.serial; await this.store.interval('offline', 'paused'); }
  async close() { this.stop(); this.state = 'disconnected'; await this.serial; await this.store.interval('offline', 'stopped'); }
  status() { return { state: this.state, error: this.error, pending: this.pending, ...this.store.stats(), model: 'not-connected', groupReplies: false }; }
}
module.exports = { GroupCollector };
