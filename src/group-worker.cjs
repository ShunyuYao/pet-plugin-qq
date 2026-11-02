'use strict';
const { FeedbackRepository, validateItems, extractionPrompt, chatPrompt } = require('./group-feedback.cjs');
const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(Error('已停止'));
  const stop = () => { clearTimeout(timer); reject(Error('已停止')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  signal?.addEventListener('abort', stop, { once: true });
});
async function isolatedModel(pet, prompt, signal) {
  if (!pet.ai?.start) throw Error('需要支持隔离 AI 任务的候选宿主');
  signal.throwIfAborted();
  const task = await pet.ai.start(prompt, { context: 'isolated', tools: [], maxSteps: 1, timeoutMs: 60000 });
  const cancel = () => { void pet.ai.cancel(task.id).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  if(signal.aborted)cancel();
  try {
    signal.throwIfAborted();
    const end = Date.now() + 65000;
    while (Date.now() < end) {
      const state = await pet.ai.get(task.id); signal.throwIfAborted();
      if (state.status === 'completed') { if (!state.text?.trim()) throw Error('模型返回空内容'); return state.text; }
      if (['failed','cancelled'].includes(state.status)) throw Error(state.error || '模型任务未完成');
      await delay(250, signal);
    }
    cancel(); throw Error('模型等待超时');
  } finally { signal.removeEventListener('abort', cancel); }
}
function bounded(messages) { return messages.slice(-16).map(row => ({ ...row, text: row.text.slice(0, 800), sender: { id: row.sender?.id, nickname: row.sender?.nickname?.slice(0,40) || null } })); }
class GroupWorker {
  constructor({ pet, config, store, collector, current, runModel, now = Date.now, minGap = 6500, extractionDelay = 15000 }) {
    Object.assign(this, { config, store, collector, current, now, minGap, extractionDelay });
    this.repo = new FeedbackRepository(store); this.runModel = runModel || ((prompt, signal) => isolatedModel(pet, prompt, signal));
    this.lastCall = 0; this.lastExtraction = now(); this.error = ''; this.running = null; this.controller = null;
  }
  start() { if (!this.config.automation || this.timer) return; this.timer = setInterval(() => { void this.tick(); }, 1000); this.timer.unref?.(); }
  async stop() { clearInterval(this.timer); this.timer = null; this.controller?.abort(Error('群任务已停止')); await this.running?.catch(() => {}); }
  async guard(signal) { signal.throwIfAborted(); if (!await this.current() || this.collector.state !== 'collecting') throw Error('采集连接或宠物身份已改变'); signal.throwIfAborted(); }
  tick() {
    if (this.running || !this.config.automation || this.collector.state !== 'collecting' || this.now() - this.lastCall < this.minGap) return Promise.resolve();
    this.controller = new AbortController(); const { signal } = this.controller;
    this.running = this.process(signal).catch(error => { this.error = error.message; }).finally(() => { this.running = null; });
    return this.running;
  }
  async model(prompt, signal) {
    await this.guard(signal); await this.repo.reserve(this.config.modelCallsPerDay); this.lastCall = this.now();
    const text = await this.runModel(prompt, signal); await this.guard(signal); return text;
  }
  async process(signal) {
    const pending = await this.repo.pending();
    if (pending.chat && this.config.replyEnabled) return this.reply(pending.chat, signal);
    if (!pending.feedback.length || this.now() - this.lastExtraction < this.extractionDelay) return;
    this.lastExtraction = this.now();
    const group = pending.feedback[0].groupId;
    const batch = pending.feedback.filter(row => row.groupId === group).slice(0, 12);
    const keys = batch.map(row => row.key);
    try {
      await this.repo.mark(keys, 'running');
      const text = await this.model(extractionPrompt(bounded(batch)), signal);
      const items = validateItems(text, keys);
      const payload=JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g,''));
      await this.repo.apply(items, batch, payload.summary); this.error = '';
    } catch (error) { await this.repo.mark(keys, 'failed', error.message).catch(() => {}); throw error; }
  }
  async reply(job, signal) {
    let phase = 'queued';
    try {
      if (this.now() - job.at > 5 * 60000) { await this.repo.job(job.key, {status:'cancelled',error:'@ 消息已超过5分钟，不补发旧回复'}); return; }
      const context = bounded(await this.repo.context(job.groupId));
      const trigger = context.find(row => row.key === job.key);
      if (!trigger) { await this.repo.job(job.key, {status:'cancelled',error:'触发原文已失效或不在近期上下文'}); return; }
      const summaries=await this.repo.summaries(job.groupId);
      const keys = [...new Set([...context.map(row=>row.key),...summaries.flatMap(row=>row.sourceIds)])];
      await this.repo.job(job.key, {status:'running',contextKeys:keys}); phase = 'running';
      const reply = (await this.model(chatPrompt(context, trigger, summaries), signal)).slice(0, 1000);
      if (!await this.repo.verify(keys)) throw Error('上下文已撤回或过期，不发送旧依据的回答');
      await this.guard(signal);
      await this.repo.job(job.key, {status:'sending',reply}); phase = 'sending';
      await this.guard(signal);
      const receipt = await this.collector.qq.sendGroup(job.groupId, reply);
      await this.repo.job(job.key, {status:'completed',receipt}); this.error = '';
    } catch (error) {
      await this.repo.job(job.key, {status:phase === 'sending' ? 'unknown' : 'failed',error:error.message}).catch(() => {});
      throw error;
    }
  }
  status() { return { model: this.config.automation ? 'host-isolated' : 'disabled', groupReplies: !!(this.config.automation && this.config.replyEnabled), processing: !!this.running, processingError: this.error }; }
}
module.exports = { GroupWorker, isolatedModel };
