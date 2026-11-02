'use strict';
// Real Electron host + utilityProcess + visible DOM. Only QQ/DSH and SMS are local protocol fixtures.
const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { fixtures, wait } = require('./fixtures.cjs');
const host = process.env.PET_PLUGIN_HOST_DIR;
if (!host) throw Error('PET_PLUGIN_HOST_DIR must point to the candidate host demo directory.');
const H = require(path.join(host, '../tests/e2e-helpers'));
const { activateButton } = require(path.join(host, '../tests/e2e/html-card-input'));
const cdp = Number(process.env.QQ_E2E_CDP_PORT || 9563);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-pet-qq-context-'));
const artifact = path.resolve(__dirname, '../artifacts/electron-' + Date.now());
let child; let f; let panel; let pet; let chat;
const value = (target, expression) => H.evalIn(target, expression);
async function type(target, selector, text) {
  await H.cdp(target, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  await value(target, `document.querySelector(${JSON.stringify(selector)}).focus()`);
  await H.cdp(target, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: process.platform === 'darwin' ? 4 : 2 });
  await H.cdp(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: process.platform === 'darwin' ? 4 : 2 });
  // Input.insertText supplies Unicode content; button/Enter activation uses real keyboard events.
  await H.cdp(target, 'Input.insertText', { text });
}
async function start() {
  child = H.launch({ userData: profile, cdpPort: cdp, bootstrap: path.join(host, '../tests/helpers/appearance-hidden-bootstrap.js'), env: { PET_E2E_TEST: '1', PET_E2E_HIDDEN: '1', PET_E2E_BACKGROUND: '1', PET_E2E_USE_MOCK_KEYCHAIN: '1', PET_PUBLIC_NATIVE_LOG: path.join(artifact, 'native.jsonl'), PET_E2E_ENV_CONFIG: JSON.stringify({ test: { accountApiBase: f.base + '/api', analyticsEvents: '', agentTrace: '', diagnostics: '' } }) } });
  const targets = await H.findReadyTarget(cdp, 'trial-entry.html', 'trialAccess').catch(() => null);
  if (targets) { await type(targets, '#phone', '19977776661'); await type(targets, '#sms', '123456'); await activateButton(targets, '.primary', { capture: false }); await H.waitTargetGone(cdp, 'trial-entry.html'); }
  pet = await H.findTarget(cdp, '/index.html'); await wait(() => value(pet, '!!window.petAPI'), 'pet API');
}
async function openPanel() { await value(pet, "petAPI.togglePluginPanel('qq-context')"); panel = await H.findReadyTarget(cdp, '/panel/index.html', 'pet'); }
const groupCall = (method, ...args) => value(panel, `pet.services.invoke('qq-context',${JSON.stringify(method)},${JSON.stringify(args)})`);
async function openChat() { await value(pet, 'petAPI.openChatWindow()'); chat = await H.findTarget(cdp, '/chat.html'); await wait(() => value(chat, '!!window.chatAPI'), 'chat API'); await wait(() => value(chat, '!!document.querySelector(".cp-input input")'), 'chat ready'); await activateButton(chat, '.cp-toggle', { capture: false }); }
async function send(text) { await type(chat, '.cp-input input', text); await H.cdp(chat, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await H.cdp(chat, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); }
(async () => {
  try {
    f = await fixtures(); fs.mkdirSync(artifact, { recursive: true });
    const pluginDir = path.join(profile, 'plugins/qq-context'); fs.mkdirSync(pluginDir, { recursive: true });
    for (const file of ['manifest.json', 'index.cjs', 'src', 'panel', 'node_modules']) fs.cpSync(path.resolve(__dirname, '..', file), path.join(pluginDir, file), { recursive: true });
    const manifest = require('../manifest.json');
    fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ onboarding: { completed: true }, character: 'qiqi', tts: { enabled: false }, general: { autoCheckUpdates: false }, relay: { url: '' }, ai: { source: 'byok', apiKey: '' }, plugins: { registrySources: [f.base], grants: { 'qq-context': { granted: [...manifest.permissions, 'service:qq-context'] } } } }));
    fs.writeFileSync(profile + '.environment-selection.json', JSON.stringify({ environment: 'test' }));
    await start(); await openPanel();
    await activateButton(panel, '#mode-private', { capture: false });
    await wait(() => value(panel, 'document.querySelector("#status").textContent.includes("尚未绑定")'), 'plugin active');
    // M1 backend acceptance through the real sandbox panel service boundary.
    // There is deliberately no group UI yet; this is NOT UI-flow acceptance.
    await groupCall('groupConnect', { ...f.config, groupIds: ['80001', '80002'], retentionDays: 7, maxEvents: 5000, collectionNoticeConfirmed: true });
    for (let n = 0; n < 10; n++) f.qqMessage(501, '群问题原话', { message_type: 'group', group_id: 80001 });
    f.qqMessage(502, '', { message_type: 'group', group_id: 80001, message: [{ type: 'image', data: { file: 'synthetic.png' } }] });
    f.qqMessage(503, '不允许的群', { message_type: 'group', group_id: 80003 });
    await wait(async () => (await groupCall('groupState')).messages === 2, 'group text/media persisted once');
    assert.equal(f.prompts.length, 0); assert.equal(f.sent.length, 0, 'collection never replies');
    assert.equal((await groupCall('groupMessages', { groupId: '80001' })).messages[0].text, '群问题原话');
    await assert.rejects(groupCall('groupMessages', { groupId: '80003' }), /无权/);
    f.qqMessage(501, '', { post_type: 'notice', notice_type: 'group_recall', group_id: 80001, operator_id: 90001 });
    await wait(async () => (await groupCall('groupMessages', { groupId: '80001' })).messages[0].availability === 'recalled', 'recall redacts original');
    const detail = await groupCall('groupMessageDetail', { groupId: '80001', messageId: '501' });
    assert.ok(!detail.content.includes('群问题原话')); assert.equal(detail.availability, 'recalled');
    await groupCall('groupPause');
    await activateButton(panel, '#mode-private', { capture: false });
    for (const [key, val] of Object.entries(f.config)) if (key !== 'exclusive') await type(panel, '#' + key, val);
    await value(panel, 'document.querySelector("#exclusive").focus()');
    await H.cdp(panel, 'Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await H.cdp(panel, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await activateButton(panel, '#connect', { capture: false });
    await wait(() => value(panel, 'document.querySelector("#status").textContent === "原会话已连接"'), 'binding established', 25000);
    await H.captureScreenshot(panel, path.join(artifact, 'connection.png'));
    assert.equal(fs.existsSync(path.join(profile, 'plugins/bili')), false, 'Bilibili is absent');
    await openChat(); await wait(() => value(chat, 'document.body.textContent.includes("青色海星")'), 'old context rendered');
    await send('桌面记住金色贝壳');
    await wait(() => f.prompts.length === 1, 'desktop prompt');
    await wait(() => value(chat, '[...document.querySelectorAll(".cp-bubble-pet")].some(n=>n.textContent.includes("金色贝壳"))'), 'desktop reply');
    assert.equal(f.sent.length, 0, 'desktop does not send QQ');
    f.qqMessage(101, 'QQ 继续贝壳话题'); f.qqMessage(101, 'QQ 继续贝壳话题');
    await wait(() => f.sent.length === 1, 'QQ reply once');
    assert.match(f.sent[0].message[0].data.text, /金色贝壳/);
    await wait(() => value(chat, 'document.body.textContent.includes("QQ 继续贝壳话题")'), 'QQ history synchronizes');
    await send('桌面接着 QQ 聊'); await wait(() => f.prompts.length === 3, 'back to desktop');
    await wait(() => value(chat, '[...document.querySelectorAll(".cp-bubble-pet")].some(n=>n.textContent.includes("桌面接着 QQ 聊"))'), 'cross channel reply');
    assert.match(f.modelInputs.at(-1).join(), /QQ 继续贝壳话题/);
    const history = await value(chat, 'chatAPI.getChatHistory({page:0})'); assert.ok(history.messages.some(m => m.text.includes('青色海星')));
    const desktopRows = await value(chat, '[...document.querySelectorAll(".cp-bubble-user")].filter(n=>n.textContent==="桌面记住金色贝壳").length'); assert.equal(desktopRows, 1, 'history/run deduplication');
    await H.captureScreenshot(chat, path.join(artifact, 'shared-chat.png'));
    f.disconnectDsh(); await wait(() => value(panel, 'document.querySelector("#status").textContent === "连接已断开"'), 'offline shown');
    await send('离线不可回落'); await new Promise(r => setTimeout(r, 1000)); assert.equal(f.prompts.length, 3); assert.equal(f.sent.length, 1);
    await activateButton(panel, '#reconnect', { capture: false }); await wait(() => value(panel, 'document.querySelector("#status").textContent === "原会话已连接"'), 'reconnected');
    await H.stopOwned(child); child = null; await start(); await openPanel();
    await activateButton(panel, '#mode-private', { capture: false });
    await wait(() => value(panel, 'document.querySelector("#status").textContent === "原会话已连接"'), 'binding restored after restart', 25000);
    await activateButton(panel, '#mode-private', { capture: false });
    assert.equal((await groupCall('groupState')).state, 'paused', 'paused group service survives restart');
    assert.equal((await groupCall('groupMessages', { groupId: '80001' })).messages.length, 2, 'encrypted group repository survives a fresh app');
    await groupCall('groupResume');
    f.qqMessage(501, '群问题原话', { message_type: 'group', group_id: 80001 });
    await new Promise(r => setTimeout(r, 300));
    assert.equal((await groupCall('groupState')).messages, 2, 'group replay after restart is deduplicated');
    await groupCall('groupPause');
    assert.equal(f.prompts.length, 3, 'restart does not replay');
    f.qqMessage(101, 'QQ 继续贝壳话题'); await new Promise(r => setTimeout(r, 500));
    assert.equal(f.prompts.length, 3, 'encrypted ledger deduplicates redelivery after restart'); assert.equal(f.sent.length, 1);
    await openChat(); await wait(() => value(chat, 'document.body.textContent.includes("QQ 继续贝壳话题")'), 'original history after restart');
    await activateButton(panel, '#disconnect', { capture: false }); await wait(() => value(panel, 'document.querySelector("#status").textContent === "尚未绑定"'), 'explicit unbind');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'external-conversations.json'))), []);
    const data = fs.readFileSync(path.join(pluginDir, 'data.json'), 'utf8'); assert.ok(!data.includes('fixture-token'), 'credentials not in plain plugin storage');
    const report = { passed: true, groupBackend: true, groupUI: false, groupMessages: 2, coreWithoutBilibili: true, realElectron: true, protocolFixture: true, realQQLogin: false, realDSHProcess: false, prompts: f.prompts.length, qqDeliveries: f.sent.length, profile, host };
    fs.writeFileSync(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2)); console.log('PASS', artifact);
  } catch (error) { fs.mkdirSync(artifact, { recursive: true }); fs.writeFileSync(path.join(artifact, 'failure.txt'), String(error.stack) + '\n' + (child?.log || '')); if(chat) { fs.writeFileSync(path.join(artifact, 'chat-debug.json'), JSON.stringify(await value(chat, 'Promise.all([chatAPI.getChatHistory({page:0}), Promise.resolve(document.body.innerText)])').catch(e=>({error:e.message})),null,2)); await H.captureScreenshot(chat,path.join(artifact,'failure.png')).catch(()=>{}); } console.error(error); process.exitCode = 1; }
  finally { if (child) await H.stopOwned(child); await f?.close(); }
})();
