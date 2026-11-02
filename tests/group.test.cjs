'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGroupEvent, validateGroupConfig } = require('../src/group-events.cjs');
const { GroupStore } = require('../src/group-store.cjs');
const { GroupCollector } = require('../src/group-collector.cjs');
const { createGroupService } = require('../src/group-service.cjs');
const { fixtures, wait } = require('./fixtures.cjs');
const config = overrides => validateGroupConfig({ qqUrl: 'ws://127.0.0.1:3001', botQQ: '90002', groupIds: ['80001', '80002'], retentionDays: 7, maxEvents: 5000, collectionNoticeConfirmed: true, ...overrides });
const event = (id = 1, overrides = {}) => ({ post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: 90002, group_id: 80001, user_id: 90001, message_id: id, time: 1700000000, sender: { nickname: '合成用户' }, message: [{ type: 'text', data: { text: '设置页打不开' } }], ...overrides });
const normalize = (raw, at = 1700000000000) => normalizeGroupEvent(raw, config(), at);
async function store(options = {}) {
  let durable = null, fail = false;
  const value = new GroupStore({ scopeId: 'scope-a', load: async () => durable, save: async data => { if (fail) throw Error('disk-full'); durable = structuredClone(data); }, retentionDays: 7, maxEvents: 5000, now: () => 1700000000000, ...options });
  await value.open();
  return { value, durable: () => durable, fail: v => { fail = v; } };
}
test('group config requires explicit group scope, retention and collection notice; rejects unsafe targets', () => {
  for (const overrides of [{ groupIds: [] }, { groupIds: ['all'] }, { groupIds: ['80001', '80001'] }, { retentionDays: undefined }, { retentionDays: 0 }, { collectionNoticeConfirmed: false }, { qqUrl: 'ws://example.com' }, { maxEvents: 0 }]) assert.throws(() => config(overrides));
  assert.deepEqual(config().groupIds, ['80001', '80002']);
});
test('normalization retains structured segments and unknown media, distinguishes real @ and self events', () => {
  const parts = [{ type: 'text', data: { text: '@机器人' } }, { type: 'at', data: { qq: '90002' } }, { type: 'reply', data: { id: '77' } }, { type: 'image', data: { file: 'fake.png' } }, { type: 'future_type', data: { value: 'opaque' } }];
  const row = normalize(event(1, { message: parts }));
  assert.equal(row.mentioned, true); assert.deepEqual(row.segments, parts); assert.deepEqual(row.replyTo, ['77']); assert.match(row.text, /\[image\]/); assert.match(row.text, /\[future_type\]/);
  for (const message of [[{ type: 'text', data: { text: '@机器人' } }], [{ type: 'at', data: { qq: 'all' } }], [{ type: 'at', data: { qq: '99999' } }]]) assert.equal(normalize(event(2, { message })).mentioned, false);
  const self = normalize(event(3, { post_type: 'message_sent', user_id: 90002, message: parts }));
  assert.equal(self.self, true); assert.equal(self.mentioned, false);
  const anonymous = normalize(event(4, { sub_type: 'anonymous', user_id: undefined, sender: undefined, anonymous: { id: 5, name: '匿名', flag: 'not-needed' } }));
  assert.equal(anonymous.sender.id, null); assert.equal(anonymous.sender.nickname, null); assert.deepEqual(anonymous.anonymous, { id: '5', name: '匿名' });
  assert.equal(normalize(event(5, { message: '[CQ:image,file=x]' })).segments[0].type, 'unparsed');
  const upload=normalize({post_type:'notice',notice_type:'group_upload',self_id:90002,group_id:80001,user_id:90001,time:1700000000,file:{id:'file-one',name:'report.txt',size:256}});
  assert.equal(upload.subtype,'file_notice');assert.equal(upload.segments[0].data.name,'report.txt');assert.equal(upload.mentioned,false);
  assert.equal(upload.key,normalize({post_type:'notice',notice_type:'group_upload',self_id:90002,group_id:80001,user_id:90001,time:1700000000,file:{id:'file-one',name:'report.txt',size:256}}).key);
});
test('only authenticated bot and allowlisted group events are accepted; invalid IDs never alias valid IDs', () => {
  for (const overrides of [{ group_id: 80003 }, { self_id: 90003 }, { message_type: 'private' }, { message_id: {} }, { message_id: 9007199254740992 }, { time: undefined }, { post_type: 'message_sent', user_id: 90001 }]) assert.equal(normalize(event(1, overrides)), null);
  assert.notEqual(normalize(event(1)).key, normalize(event(1, { group_id: 80002 })).key);
  assert.notEqual(normalize(event(-1)).key, normalize(event(1)).key);
});
test('durable store serializes replay, isolates groups, pages within SDK budget and survives restart', async () => {
  const f = await store();
  const row = normalize(event());
  await Promise.all(Array.from({ length: 10 }, () => f.value.append(row)));
  await f.value.append(normalize(event(1, { group_id: 80002 })));
  assert.equal(f.value.stats().messages, 2);
  assert.equal((await f.value.query({ groupId: '80001' })).messages.length, 1);
  const restored = new GroupStore({ scopeId: 'scope-a', load: async () => f.durable(), save: async () => {}, retentionDays: 7, maxEvents: 5000, now: () => 1700000000000 });
  await restored.open(); assert.equal(restored.stats().messages, 2);
  await assert.rejects(new GroupStore({ scopeId: 'scope-b', load: async () => f.durable(), save: async () => {}, retentionDays: 7, maxEvents: 5000 }).open(), /scope/);
  await f.value.append(normalize(event(9, { message: [{ type: 'text', data: { text: '长'.repeat(20000) } }] })));
  const page = await f.value.query({ groupId: '80001', limit: 50 });
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 60000); assert.ok(page.messages.some(m => m.contentTruncated));
});
test('recall before or after original removes raw content and invalidates quoted references', async () => {
  const f = await store();
  const recall = normalize({ post_type: 'notice', notice_type: 'group_recall', self_id: 90002, group_id: 80001, message_id: 1, user_id: 90001, operator_id: 90003, time: 1700000001 });
  await f.value.append(normalize(event(2, { message: [{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '同样的问题' } }] })));
  await f.value.append(recall); await f.value.append(normalize(event(1))); await f.value.append(recall);
  const rows = (await f.value.query({ groupId: '80001' })).messages;
  assert.equal(rows.find(m => m.messageId === '1').availability, 'recalled');
  assert.deepEqual(rows.find(m => m.messageId === '1').segments, []);
  assert.equal(rows.find(m => m.messageId === '2').references[0].availability, 'recalled');
  assert.ok(!JSON.stringify(f.durable()).includes('设置页打不开'));
});
test('write failure is never acknowledged or visible as saved; capacity fails closed without erasing records', async () => {
  const f = await store({ maxEvents: 1 }); f.fail(true);
  await assert.rejects(f.value.append(normalize(event())), /disk-full/); assert.equal(f.value.stats().messages, 0);
  f.fail(false); await f.value.append(normalize(event()));
  await assert.rejects(f.value.append(normalize(event(2))), /capacity/); assert.equal(f.value.stats().messages, 1);
});
test('retention expires raw content without resurrecting replay, including on read while idle', async () => {
  let now = 1700000000000;
  const f = await store({ now: () => now }); await f.value.append(normalize(event()));
  now += 8 * 86400000;
  const row = (await f.value.query({ groupId: '80001' })).messages[0];
  assert.equal(row.availability, 'expired'); assert.deepEqual(row.segments, []);
  await f.value.append(normalize(event(), now));
  assert.equal((await f.value.query({ groupId: '80001' })).messages[0].availability, 'expired');
});
test('live collector persists all new group types once, never generates or sends, and closes on stale identity', async () => {
  const f = await fixtures(); const s = await store({ now: Date.now }); let active = true;
  const collector = new GroupCollector({ config: config({ ...f.config }), store: s.value, current: async () => active });
  try {
    await collector.open();
    for (let n = 0; n < 10; n++) f.qqMessage(1, '群原话', { message_type: 'group', group_id: 80001 });
    f.qqMessage(2, '', { message_type: 'group', group_id: 80001, message: [{ type: 'image', data: { file: 'fake' } }] });
    f.qqMessage(3, '禁止采集', { message_type: 'group', group_id: 80003 });
    await wait(() => s.value.stats().messages === 2);
    assert.equal(f.prompts.length, 0); assert.equal(f.sent.length, 0);
    await collector.pause();
    f.qqMessage(4, '暂停期间', { message_type: 'group', group_id: 80001 });
    await new Promise(r => setTimeout(r, 60)); assert.equal(s.value.stats().messages, 2);
    await collector.open(); active = false;
    f.qqMessage(5, '错误身份', { message_type: 'group', group_id: 80001 });
    await wait(() => collector.status().state === 'offline'); assert.equal(s.value.stats().messages, 2);
    assert.ok(s.durable().intervals.some(i => i.reason === 'paused'));
  } finally { await collector.close(); await f.close(); }
});
test('panel service keeps encrypted scope repositories separate, restores paused state and rejects foreign callers', async () => {
  const f = await fixtures(); const vault = new Map(); let identity = { scopeId: 'scope-a', revision: 'a1' };
  let query;
  const pet = { tools:{register:spec=>{query=spec;}}, profile: { getScope: async () => ({ ...identity }) }, secrets: { get: async key => structuredClone(vault.get(key) ?? null), set: async (key, data) => { vault.set(key, structuredClone(data)); }, delete: async key => vault.delete(key) } };
  const caller = { sdkCaller: { kind: 'plugin', id: 'qq-context', context: 'panel' } };
  let service = createGroupService(pet);
  try {
    await service.start();
    await assert.rejects(query.handler({}, {source:'plugin-task'}),/主聊天/);
    await assert.rejects(service.api.groupConnect(config({ ...f.config }), {}), /面板/);
    await service.api.groupConnect(config({ ...f.config }), caller);
    f.qqMessage(100, '群测试证据', { message_type: 'group', group_id: 80001 });
    await wait(async () => (await service.api.groupState(caller)).messages === 1);
    assert.ok(!JSON.stringify(await service.api.groupState(caller)).includes('fixture-token'));
    await assert.rejects(service.api.groupMessages({ groupId: '80003' }, caller), /无权/);
    assert.equal((await service.api.groupMessages({ groupId: '80001' }, caller)).messages[0].text, '群测试证据');
    await service.api.groupPause(caller);
    await service.api.groupUpdateConnection({qqToken:'changed-synthetic-token'},caller);
    assert.equal((await service.api.groupMessages({groupId:'80001'},caller)).messages.length,1,'credential rotation preserves evidence');
    service.dispose(); service = createGroupService(pet); await service.start();
    assert.equal((await service.api.groupState(caller)).state, 'paused');
    assert.equal((await service.api.groupMessages({ groupId: '80001' }, caller)).messages.length, 1);
    identity = { scopeId: 'scope-b', revision: 'b1' };
    await assert.rejects(service.api.groupMessages({ groupId: '80001' }, caller), /身份/);
    await service.contextChanged(); assert.equal((await service.api.groupState(caller)).messages, 0);
    identity = { scopeId: 'scope-a', revision: 'a2' }; await service.contextChanged();
    assert.equal((await service.api.groupState(caller)).messages, 1);
    await assert.rejects(service.api.groupClear({ confirm: 'yes' }, caller), /确认/);
    await service.api.groupClear({ confirm: '删除当前测试桌宠的群采集数据' }, caller);
    assert.equal((await service.api.groupState(caller)).state, 'disconnected');
  } finally { service.dispose(); await f.close(); }
});
test('raw detail chunks reconstruct long original segments without exceeding the service envelope', async () => {
  const f = await store(); const segments = [{ type: 'text', data: { text: '原话\\\"'.repeat(10000) } }];
  await f.value.append(normalize(event(99, { message: segments })));
  let raw = '', offset = 0;
  do {
    const chunk = await f.value.detail({ botId: '90002', groupId: '80001', messageId: '99', offset });
    assert.ok(Buffer.byteLength(JSON.stringify(chunk)) < 60000); raw += chunk.content; offset = chunk.hasMore ? chunk.next : 0;
  } while (offset);
  assert.deepEqual(JSON.parse(raw).segments, segments);
});
test('restart marks the unobserved interval unknown instead of claiming continuous collection', async () => {
  let now = 1700000000000; const f = await store({ now: () => now });
  await f.value.interval('online', 'connected'); now += 1000; await f.value.maintenance();
  now += 100000; await f.value.recover();
  const intervals = f.value.stats().intervals;
  assert.equal(intervals[0].endedAt, 1700000001000);
  assert.equal(intervals[1].state, 'unknown'); assert.equal(intervals[1].endedAt, now);
});
