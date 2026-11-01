'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { Engine, validateConfig } = require('../src/engine.cjs'); const { Dsh, assistantText } = require('../src/dsh.cjs');
const { fixtures, wait } = require('./fixtures.cjs');
test('existing session continues across channels; source routing, dedupe, scope and unknown delivery', async () => {
  const f = await fixtures(); let saved = {}; let active = true;
  const e = new Engine({ config: validateConfig(f.config), ledger: {}, save: async rows => { saved = structuredClone(rows); }, changed: () => {}, current: async () => active });
  try {
    await e.open(); assert.match((await e.dsh.history()).messages[0].content, /青色海星/);
    await e.submit('desktop-1', '桌面补充金色贝壳'); await wait(() => e.poll('desktop-1').status === 'completed');
    assert.equal(f.sent.length, 0); assert.match(e.poll('desktop-1').text, /青色海星/);
    f.qqMessage(1, '接着聊刚才桌面的贝壳'); f.qqMessage(1, '接着聊刚才桌面的贝壳');
    await wait(() => f.sent.length === 1); assert.equal(f.sent[0].user_id, 90001); assert.match(f.sent[0].message[0].data.text, /金色贝壳/); assert.equal(f.prompts.length, 2);
    await e.submit('desktop-2', '继续刚才 QQ 的话题'); await wait(() => e.poll('desktop-2').status === 'completed'); assert.match(f.modelInputs.at(-1).join(), /接着聊刚才桌面/);
    for (const override of [{ user_id: 77777 }, { message_type: 'group', group_id: 3 }, { post_type: 'message_sent' }, { user_id: 90002 }, { sub_type: 'group' }, { time: 1 }, { message: [{ type: 'image', data: { file: 'x' } }] }]) f.qqMessage(3, 'must-ignore', override);
    await new Promise(r => setTimeout(r, 100)); assert.equal(f.prompts.length, 3);
    f.setDropReceipt(true); f.qqMessage(4, '回执丢失测试'); await wait(() => saved['qq:90002:4']?.status === 'unknown'); assert.equal(f.sent.length, 2);
    f.qqMessage(4, '回执丢失测试'); await new Promise(r => setTimeout(r, 100)); assert.equal(f.sent.length, 2);
    active = false; await assert.rejects(e.submit('desktop-3', 'wrong-scope'), /身份/); assert.equal(f.prompts.length, 4);
  } finally { e.close(); await f.close(); }
});
test('cancel prevents queued submission and running result delivery; restart never replays', async () => {
  const f = await fixtures(); f.setSlow(true); let saved;
  const e = new Engine({ config: f.config, ledger: {}, save: async rows => { saved = structuredClone(rows); }, changed: () => {}, current: async () => true });
  try {
    await e.open(); await e.submit('first', 'running'); await e.submit('second', 'queued'); await e.cancel('second');
    await wait(() => f.prompts.length === 1); await e.cancel('first'); await wait(() => !e.draining);
    assert.equal(f.prompts.length, 1); assert.equal(saved.first.status, 'cancelled'); assert.equal(f.sent.length, 0);
    const restored = new Engine({ config: f.config, ledger: { ...saved, interrupted: { id: 'interrupted', source: 'qq', status: 'sending', at: Date.now() } }, save: async () => {}, changed: () => {}, current: async () => true });
    assert.equal(restored.ledger.interrupted.status, 'unknown'); assert.equal(restored.queue.length, 0); restored.close();
  } finally { e.close(); await f.close(); }
});
test('validation and text projection omit private reasoning and reject unsafe targets', () => {
  assert.equal(assistantText({ stream: [{ type: 'reasoning-chunks', texts: ['private'], index: 0 }, { type: 'text-chunks', texts: ['hello'], index: 1 }, { type: 'chunk', chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'hello' } } }] }), 'hello');
  for (const dshUrl of ['http://evil.example', 'http://127.0.0.1/?token=x', 'http://a:b@localhost', 'file:///tmp']) assert.throws(() => new Dsh({ dshUrl }), /本机|Invalid/);
});
