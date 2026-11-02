'use strict';
const { messageKey } = require('./group-events.cjs');
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const PAGE_BYTES = 48000;
// This independent encrypted pilot repository is not the legacy chat ledger.
// Commit a copy only after the host confirms its atomic secrets write succeeded.
class GroupStore {
  constructor({ scopeId, load, save, retentionDays, maxEvents, now = Date.now, maxBytes = MAX_STORE_BYTES }) {
    Object.assign(this, { scopeId, load, save, retentionDays, maxEvents, now, maxBytes });
    this.serial = Promise.resolve(); this.data = null;
  }
  async open() {
    const saved = await this.load();
    if (saved !== null && saved !== undefined && (saved.version !== 1 || saved.scopeId !== this.scopeId || !Array.isArray(saved.messages) || !Array.isArray(saved.intervals))) throw Error('group-store-schema-or-scope-invalid');
    this.data = saved ? structuredClone(saved) : { version: 1, scopeId: this.scopeId, messages: [], intervals: [], sequence: 0 };
    this.data.feedback ||= []; this.data.jobs ||= []; this.data.calls ||= {};
    this.data.summaries ||= [];
    for (const row of this.data.messages) if (!row.feedbackStatus) row.feedbackStatus = row.self ? 'skipped' : 'pending';
    if (!Number.isSafeInteger(this.data.sequence) || this.data.sequence < 0 || new Set(this.data.messages.map(row => row?.key)).size !== this.data.messages.length
      || this.data.messages.some(row => !row || typeof row.key !== 'string' || row.key !== messageKey(row.botId, row.groupId, row.messageId)
        || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || row.sequence > this.data.sequence
        || !Number.isFinite(row.receivedAt) || !['available', 'expired', 'recalled'].includes(row.availability) || !Array.isArray(row.segments))) throw Error('group-store-corrupt');
  }
  transaction(change) {
    const job = this.serial.then(async () => {
      if (!this.data) throw Error('group-store-not-open');
      const next = structuredClone(this.data);
      let dirty = this.expire(next);
      const result = change(next, () => { dirty = true; });
      if (dirty) {
        if (Buffer.byteLength(JSON.stringify(next)) > this.maxBytes) throw Error('group-store-capacity-bytes');
        await this.save(next); this.data = next;
      }
      return result;
    });
    this.serial = job.catch(() => {}); return job;
  }
  expire(data) {
    let changed = false;
    for (const row of data.messages) if (row.availability === 'available' && this.now() - row.receivedAt >= this.retentionDays * 86400000) {
      this.redact(row, 'expired'); this.invalidate(data, row.key); changed = true;
    }
    return changed;
  }
  redact(row, availability) {
    row.availability = availability; row.segments = []; row.text = ''; row.sender = { id: null, nickname: null, card: null }; row.anonymous = null;
    row.mentioned = false; row.replyTo = [];
    row.feedbackError = ''; row.feedbackStatus = 'skipped';
  }
  invalidate(data, key) {
    for (const item of data.feedback) if (item.sourceIds.includes(key)) {
      item.evidenceChanged = true; item.title = '来源已撤回或过期'; item.description = ''; item.platform = null; item.version = null; item.reproduction = null;
    }
    data.evidenceRevision = (data.evidenceRevision || 0) + 1;
    for(const summary of data.summaries)if(summary.sourceIds.includes(key)){summary.text='';summary.availability='invalid';}
    for (const job of data.jobs) if (job.key === key || job.contextKeys?.includes(key)) { job.reply = ''; job.error='来源已撤回或过期'; if (job.status === 'sending') job.status = 'unknown'; else if (!['completed','unknown'].includes(job.status)) job.status = 'cancelled'; }
  }
  append(event) {
    return this.transaction((data, dirty) => {
      let row = data.messages.find(value => value.key === event.key);
      if (event.kind === 'recall') {
        if (row?.availability === 'recalled') return { inserted: false };
        if (!row) {
          if (data.messages.length >= this.maxEvents) throw Error('group-store-capacity-events');
          row = { key: event.key, botId: event.botId, groupId: event.groupId, messageId: event.messageId, occurredAt: event.occurredAt, receivedAt: event.receivedAt, sequence: ++data.sequence, self: false, subtype: null };
          data.messages.push(row);
        }
        this.redact(row, 'recalled'); this.invalidate(data, row.key); row.recalledAt = event.occurredAt; dirty();
        return { inserted: false, recalled: true };
      }
      if (row) return { inserted: false };
      if (data.messages.length >= this.maxEvents) throw Error('group-store-capacity-events');
      data.messages.push({ ...structuredClone(event), availability: 'available', sequence: ++data.sequence, feedbackStatus: event.self ? 'skipped' : 'pending' });
      if (event.mentioned && !event.self) data.jobs.push({ key: event.key, groupId: event.groupId, status: 'queued', at: event.receivedAt });
      dirty();
      const interval = data.intervals.at(-1);
      if (interval?.state === 'online' && interval.endedAt === null) interval.lastObservedAt = this.now();
      return { inserted: true };
    });
  }
  interval(state, reason, at = this.now()) {
    return this.transaction((data, dirty) => {
      const previous = data.intervals.at(-1);
      if (previous && previous.state === state && previous.reason === reason && previous.endedAt === null) return;
      if (previous?.endedAt === null) previous.endedAt = at;
      if (data.intervals.length >= 2000) throw Error('group-store-capacity-intervals');
      data.intervals.push({ state, reason, startedAt: at, endedAt: null, lastObservedAt: at }); dirty();
    });
  }
  query({ groupId, botId, after = 0, limit = 20 } = {}) {
    if (typeof groupId !== 'string' || !/^\d{1,16}$/.test(groupId) || !Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) return Promise.reject(Error('invalid-group-query'));
    return this.transaction(data => {
      const eligible = data.messages.filter(row => row.groupId === groupId && (!botId || row.botId === botId) && row.sequence > after);
      const messages = []; let bytes = 0;
      for (const row of eligible.slice(0, limit)) {
        let item = structuredClone(row);
        item.references = (row.replyTo || []).map(messageId => {
          const target = data.messages.find(v => v.key === messageKey(row.botId, row.groupId, messageId));
          return { messageId, availability: target?.availability || 'missing' };
        });
        if (Buffer.byteLength(JSON.stringify(item)) > 24000) {
          item = { key: row.key, groupId: row.groupId, botId: row.botId, messageId: row.messageId, sequence: row.sequence, occurredAt: row.occurredAt, receivedAt: row.receivedAt, availability: row.availability, text: row.text.slice(0, 2000), segments: [], references: item.references.slice(0, 50), self: row.self, mentioned: row.mentioned, contentTruncated: true };
        }
        const size = Buffer.byteLength(JSON.stringify(item));
        if (bytes + size > PAGE_BYTES) break;
        messages.push(item); bytes += size;
      }
      return { messages, next: messages.at(-1)?.sequence ?? after, hasMore: eligible.length > messages.length };
    });
  }
  maintenance() { return this.transaction((data, dirty) => {
    const last = data.intervals.at(-1);
    if (last?.state === 'online' && last.endedAt === null) { last.lastObservedAt = this.now(); dirty(); }
  }); }
  recover() { return this.transaction((data, dirty) => {
    const last = data.intervals.at(-1);
    if (last?.state !== 'online' || last.endedAt !== null) return;
    const observed = last.lastObservedAt ?? last.startedAt;
    last.endedAt = observed;
    data.intervals.push({ state: 'unknown', reason: 'process-interrupted', startedAt: observed, endedAt: this.now(), lastObservedAt: observed }); dirty();
  }); }
  detail({ groupId, botId, messageId, offset = 0 } = {}) {
    if (![groupId, botId, messageId].every(v => typeof v === 'string') || !Number.isSafeInteger(offset) || offset < 0) return Promise.reject(Error('invalid-group-detail'));
    return this.transaction(data => {
      const row = data.messages.find(v => v.key === messageKey(botId, groupId, messageId));
      if (!row) return null;
      const raw = JSON.stringify({ segments: row.segments, sender: row.sender, anonymous: row.anonymous, replyTo: row.replyTo });
      return { key: row.key, availability: row.availability, encoding: 'json', content: raw.slice(offset, offset + 4000), next: Math.min(raw.length, offset + 4000), hasMore: offset + 4000 < raw.length };
    });
  }
  stats() { return { messages: this.data?.messages.length || 0, available: this.data?.messages.filter(row => row.availability === 'available').length || 0, intervals: structuredClone(this.data?.intervals.slice(-20) || []) }; }
}
module.exports = { GroupStore };
