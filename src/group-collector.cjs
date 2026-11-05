'use strict';
const { OneBot } = require('./onebot.cjs');
const { normalizeGroupEvent } = require('./group-events.cjs');
const { OfficialBot } = require('./official-bot.cjs');
const { normalizeOfficialEvent } = require('./official-events.cjs');
class GroupCollector {
  constructor({ config, store, current, now = Date.now }) {
    Object.assign(this, { config, store, current, now });
    this.qq = null; this.serial = Promise.resolve(); this.generation = 0; this.state = 'disconnected'; this.error = ''; this.pending = 0;
    this.ingest = {received:0,normalized:0,rejected:0,persisted:0,duplicates:0};this.lastGatewayDiagnostics=null;
  }
  async guard(generation) {
    if (generation !== this.generation || !await this.current()) throw Error('群采集身份或连接已改变。');
  }
  async open() {
    this.stop(); const generation = this.generation; this.state = 'connecting'; this.error = '';
    this.ingest = {received:0,normalized:0,rejected:0,persisted:0,duplicates:0};this.lastGatewayDiagnostics=null;
    try {
      await this.guard(generation);
      // An unclosed last interval is not evidence of continuous availability.
      await this.store.interval('offline', 'connection-start');
      const qq = this.qq = this.config.provider === 'official' ? new OfficialBot(this.config) : new OneBot(this.config);
      qq.on('group-event', raw => this.enqueue(raw, generation));
      qq.on('offline', message => { if (generation === this.generation) this.fail(message || 'QQ 已断开，离线消息未采集。'); });
      qq.on('reconnecting', () => {
        if (generation !== this.generation) return;
        this.state = 'reconnecting'; this.error = '腾讯 SDK 正在恢复连接，期间消息完整性未知。';
        this.serial = this.serial.then(async () => { await this.guard(generation); await this.store.interval('offline','sdk-reconnecting'); })
          .catch(error => { if (generation === this.generation) this.fail(error.message); });
      });
      qq.on('reconnected', () => {
        if (generation !== this.generation) return;
        this.state = 'connecting';
        this.serial = this.serial.then(async () => {
          await this.guard(generation); await this.store.interval('online','sdk-reconnected'); await this.guard(generation);
          if (qq.ready) { this.state = 'collecting'; this.error = ''; }
        }).catch(error => { if (generation === this.generation) this.fail(error.message); });
      });
      await qq.open(); await this.guard(generation);
      await this.store.interval('online', 'connected'); this.state = 'collecting';
      this.timer = setInterval(() => {
        this.serial = this.serial.then(async () => { await this.guard(generation); await this.store.maintenance(); }).catch(() => this.fail('群数据维护失败或身份已改变，请核对后重连。'));
      }, 60000); this.timer.unref?.();
    } catch (error) { if (generation === this.generation) this.fail(error.message); throw error; }
  }
  enqueue(raw, generation) {
    if (generation !== this.generation || !['collecting', 'connecting'].includes(this.state)) return;
    this.ingest.received++;
    if (this.pending >= 200) { this.fail('群事件积压超限，已停止采集；请核对缺失区间。'); return; }
    this.pending++;
    this.serial = this.serial.then(async () => {
      if (generation !== this.generation) return;
      await this.guard(generation);
      const event = this.config.provider === 'official' ? normalizeOfficialEvent(raw, this.config, this.now()) : normalizeGroupEvent(raw, this.config, this.now());
      if (event) {
        this.ingest.normalized++;
        const result=await this.store.append(event);if(result.inserted)this.ingest.persisted++;else this.ingest.duplicates++;
        await this.guard(generation);
      } else this.ingest.rejected++;
    }).catch(error => { if (generation === this.generation) this.fail(error.message); }).finally(() => { this.pending--; });
  }
  stop() { ++this.generation; clearInterval(this.timer); if(this.qq?.diagnostics)this.lastGatewayDiagnostics=this.qq.diagnostics();this.qq?.close(); this.qq = null; }
  fail(message) {
    this.stop(); this.state = 'offline'; this.error = message;
    this.serial = this.serial.then(() => this.store.interval('offline', 'error')).catch(() => {});
  }
  async pause() { this.stop(); this.state = 'paused'; await this.serial; await this.store.interval('offline', 'paused'); }
  async close() { this.stop(); this.state = 'disconnected'; await this.serial; await this.store.interval('offline', 'stopped'); }
  status() { return { state: this.state, error: this.error, pending: this.pending, ...this.store.stats(), model: 'not-connected', groupReplies: false,
    receiveDiagnostics:{...this.ingest,gateway:this.qq?.diagnostics?.()||this.lastGatewayDiagnostics} }; }
}
module.exports = { GroupCollector };
