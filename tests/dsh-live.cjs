'use strict';
// Real pinned DSH process and persistence; local model transport and QQ protocol fixture.
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const http = require('node:http'); const assert = require('node:assert/strict');
const { spawn } = require('node:child_process'); const { randomUUID } = require('node:crypto');
const { Dsh } = require('../src/dsh.cjs'); const { Engine } = require('../src/engine.cjs'); const { fixtures, wait } = require('./fixtures.cjs');
const bin = process.env.QQ_TEST_DSH_BIN; if (!bin) throw Error('Set QQ_TEST_DSH_BIN to the installed @deepseek-ai/dsh 0.2.1-rc.2 lib/bin.js.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-qq-real-dsh-')); const inputs = []; let child; let model; let f; let dsh; let engine; let log = '';
const artifact = path.resolve(__dirname, '../artifacts/dsh-live-' + Date.now());
(async () => { try {
  fs.mkdirSync(artifact, { recursive: true });
  assert.equal(JSON.parse(fs.readFileSync(path.resolve(bin, '../../package.json'))).version, '0.2.1-rc.2');
  model = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); inputs.push(input);
    const content = '记忆接续：' + input.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : m.content.filter(p => p.type === 'text').map(p => p.text).join('')).join('；');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ id: 'fixture-' + inputs.length, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const patch = path.join(root, 'patch.yml'); fs.writeFileSync(patch, JSON.stringify([
    { id: 'llm-pi-ai', config: { providers: { 'qq-fixture': { api: 'openai-completions', apiKeyEnv: 'QQ_TEST_MODEL_KEY', baseURL: 'http://127.0.0.1:' + model.address().port + '/v1', models: [{ id: 'fixture-model', contextWindow: 32000, maxTokens: 500 }] } } } },
    { id: 'agent-default-model', config: { provider: 'qq-fixture', model: 'fixture-model' } },
    { id: 'session-title-llm', disabled: true },
  ]));
  child = spawn(process.execPath, [bin, '--profile', 'web', '--patch', patch, '--no-open', '--port', '0'], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: path.join(root, 'home'), QQ_TEST_MODEL_KEY: 'local-fixture-key' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
  await wait(() => /dsh web: (http:\/\/\S+)/.test(log) || child.exitCode !== null, 'DSH boot', 30000);
  const match = /dsh web: (http:\/\/\S+)/.exec(log); if (!match) throw Error('DSH startup failed: ' + log.replace(/token=[^\s]+/g, 'token=<redacted>'));
  const login = new URL(match[1]); const token = login.searchParams.get('token'); const base = login.origin;
  const res = await fetch(login, { redirect: 'manual' }); const cookie = res.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
  const rpcId = randomUUID(); const created = await (await fetch(base + '/api/session/create', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'client-request', rpcId, method: 'session/create', payload: { args: { request: { cwd: root } } } }) })).json();
  assert.equal(created.result?.ok, true, JSON.stringify(created)); const sessionId = created.result.value.sessionId;
  f = await fixtures(); const config = { ...f.config, dshUrl: base, dshToken: token, sessionId };
  dsh = new Dsh(config); await dsh.open(); const oldId = randomUUID(); await dsh.prompt(oldId, '接入前的 QQ 宠物记得青色海星');
  await wait(() => dsh.outcome(oldId).terminal, 'pre-existing turn', 20000); assert.equal(dsh.outcome(oldId).terminal, 'completed'); dsh.close();
  engine = new Engine({ config, ledger: {}, save: async () => {}, changed: () => {}, current: async () => true }); await engine.open();
  assert.ok((await engine.dsh.history()).messages.some(m => m.content.includes('青色海星')));
  const desktopId = randomUUID(); await engine.submit(desktopId, '桌面补充金色贝壳'); await wait(() => engine.poll(desktopId).status === 'completed', 'desktop turn', 20000);
  assert.equal(f.sent.length, 0); assert.match(JSON.stringify(inputs.at(-1).messages), /青色海星/);
  f.qqMessage(555, 'QQ 追问桌面的贝壳'); await wait(() => f.sent.length === 1, 'QQ turn', 20000);
  assert.match(JSON.stringify(inputs.at(-1).messages), /金色贝壳/); assert.match(f.sent[0].message[0].data.text, /青色海星/);
  const id2 = randomUUID(); await engine.submit(id2, '回桌面接着 QQ 聊'); await wait(() => engine.poll(id2).status === 'completed', 'second desktop turn', 20000);
  assert.match(JSON.stringify(inputs.at(-1).messages), /QQ 追问/);
  fs.writeFileSync(path.join(artifact, 'report.json'), JSON.stringify({ passed: true, dshVersion: '0.2.1-rc.2', realDshProcess: true, model: 'local deterministic SSE fixture', realQQLogin: false, modelCalls: inputs.length, qqDeliveries: f.sent.length }, null, 2));
  console.log('PASS real DSH', artifact);
} catch (error) { fs.mkdirSync(artifact, { recursive: true }); fs.writeFileSync(path.join(artifact, 'failure.txt'), String(error.stack) + '\n' + log.replace(/token=[^\s]+/g, 'token=<redacted>')); console.error(error); process.exitCode = 1; }
finally { engine?.close(); dsh?.close(); if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(r, 3000))]); if (child.exitCode === null) child.kill('SIGKILL'); } await f?.close(); model?.closeAllConnections(); if (model) await new Promise(r => model.close(r)); }
})();
