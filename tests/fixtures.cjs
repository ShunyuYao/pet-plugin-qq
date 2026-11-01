'use strict';
const http = require('node:http');
const { WebSocketServer } = require('ws');
async function fixtures() {
  const records = []; const follows = new Map(); const qqClients = new Set(); const prompts = []; const sent = []; const modelInputs = [];
  let seq = 0; let turn = 0; let dropReceipt = false; let slow = false;
  function event(type, data) { const record = { type: 'event', event: { seq: ++seq, time: Date.now(), type, data } }; records.push(record); for (const [ws, streamId] of follows) if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'item', streamId, value: record })); return record; }
  function addTurn(text, requestId, reply) {
    const t = ++turn; event('turn/start', { turn: t }); event('user/message', { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: requestId } });
    event('assistant/message', { turn: t, step: 1, stream: [{ type: 'text-chunks', index: 0, time0: Date.now(), dt: [], texts: [reply] }] }); event('turn/end', { turn: t, reason: { kind: 'completed' } });
  }
  addTurn('接入前我最喜欢青色海星。', 'existing-qq-message', '记住了，你喜欢青色海星。');
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/?token=')) { res.setHeader('set-cookie', 'dsh-test=session; HttpOnly; SameSite=Strict'); res.statusCode = 302; return res.end('{}'); }
    if (req.url.includes('/api/activation/')) return res.end(JSON.stringify(req.url.includes('/phone/verify') ? { phoneProof: 'qq-fixture', expiresIn: 600 } : { environment: 'test', accessToken: 'fixture.access', refreshToken: 'fixture.refresh', expiresIn: 3600, user: { uid: 101, nickname: 'fixture', character: 'qiqi' } }));
    if (!req.url.startsWith('/api/session/')) return res.end(JSON.stringify({ schemaVersion: 1, plugins: [], blocked: [] }));
    let raw = ''; for await (const chunk of req) raw += chunk;
    const envelope = JSON.parse(raw); const request = envelope.payload.args.request;
    let value;
    if (envelope.method === 'session/page') value = { records: records.filter(r => r.event.seq < request.beforeSeq && r.event.seq <= request.throughSeq), hasMore: false };
    else if (envelope.method === 'session/prompt') {
      if (request.sessionId !== 'existing-pet' || request.mode !== 'queue' || !request.requestId) throw Error('invalid-request');
      if (!prompts.some(p => p.requestId === request.requestId)) {
        prompts.push(request); modelInputs.push([...records.filter(r => r.event.type === 'user/message').map(r => r.event.data.content[0].text), request.content[0].text]);
        const text = request.content[0].text;
        setTimeout(() => addTurn(text, request.requestId, '原会话续聊：' + modelInputs.at(-1).join('；')), slow ? 600 : 30);
      }
      value = { accepted: true };
    } else { res.statusCode = 404; return res.end('{}'); }
    res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } }));
  });
  const dsh = new WebSocketServer({ noServer: true });
  const qq = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => { const selected = req.url === '/api/remote.mux' ? dsh : qq; selected.handleUpgrade(req, socket, head, ws => selected.emit('connection', ws)); });
  dsh.on('connection', ws => { ws.on('message', raw => { const frame = JSON.parse(raw); if (frame.endpoint !== 'session/follow' || frame.payload.args.request.address.sessionId !== 'existing-pet') return ws.close(); follows.set(ws, frame.streamId); ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'snapshot', header: { id: 'existing-pet', version: 5 }, cursor: seq, records, hasMore: false } })); }); ws.on('close', () => follows.delete(ws)); });
  qq.on('connection', ws => { qqClients.add(ws); ws.on('close', () => qqClients.delete(ws)); ws.on('message', raw => { const m = JSON.parse(raw); let data;
    if (m.action === 'get_login_info') data = { user_id: 90002 };
    else if (m.action === 'send_private_msg') { sent.push(m.params); data = { message_id: sent.length }; if (dropReceipt) { ws.close(); return; } }
    else throw Error('unexpected-onebot-action');
    ws.send(JSON.stringify({ echo: m.echo, status: 'ok', retcode: 0, data }));
  }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const config = { dshUrl: base, qqUrl: base.replace('http:', 'ws:'), dshToken: 'fixture-token', qqToken: 'fixture-token', sessionId: 'existing-pet', botQQ: '90002', ownerQQ: '90001', exclusive: true };
  return { config, base, prompts, sent, modelInputs, records, addTurn,
    setDropReceipt(v) { dropReceipt = v; }, setSlow(v) { slow = v; },
    qqMessage(id, text, override = {}) { const m = { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 90002, user_id: 90001, message_id: id, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text } }], ...override }; for (const ws of qqClients) if (ws.readyState === 1) ws.send(JSON.stringify(m)); },
    disconnectDsh() { for (const ws of follows.keys()) ws.close(); },
    async close() { for (const ws of [...follows.keys(), ...qqClients]) ws.terminate(); dsh.close(); qq.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
const wait = async (check, label = 'condition', ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 30)); } throw Error('timeout: ' + label); };
module.exports = { fixtures, wait };
