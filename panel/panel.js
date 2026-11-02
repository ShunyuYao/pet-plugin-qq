'use strict';
const $ = id => document.getElementById(id);
const call = (method, args = []) => window.pet.services.invoke('qq-context', method, args);
let loaded = false; let busy = false;
const states = { connected: '原会话已连接', offline: '连接已断开', connecting: '正在验证连接', disconnected: '尚未绑定' };
const jobStates = { queued: '排队', running: '原会话生成中', sending: '正在发回 QQ', completed: '已完成', unknown: '结果待核对', cancelled: '已停止等待', failed: '失败' };
async function refresh() {
  if (document.getElementById('private-mode')?.hidden) return;
  try {
    const value = await call('state'); $('status').textContent = states[value.state] || value.state;
    $('detail').textContent = value.error || (value.bound ? '在桌宠主聊天窗口继续聊；QQ 提问只回复主人 QQ。' : '先确认原会话，再连接。');
    $('dot').className = value.state === 'connected' ? 'online' : '';
    $('connection').hidden = value.bound; $('actions').hidden = !value.bound;
    $('connect').disabled = busy || value.state === 'connecting';
    if (!loaded) { for (const [key, val] of Object.entries(value.config || {})) if ($(key)) $(key).value = val; loaded = true; }
    if (value.jobs?.length) {
      $('jobs').replaceChildren(...value.jobs.map(row => { const li = document.createElement('li'); li.textContent = `${row.source === 'qq' ? 'QQ' : '桌面'} · ${jobStates[row.status] || row.status}${row.error ? ' · ' + row.error : ''}`; return li; }));
    }
  } catch (e) { $('detail').textContent = e.message; }
}
async function action(method, args) { busy = true; try { await call(method, args); await refresh(); } catch (e) { $('detail').textContent = e.message; } finally { busy = false; } }
$('connection').addEventListener('submit', async e => { e.preventDefault(); const input = Object.fromEntries(['dshUrl','sessionId','dshToken','qqUrl','qqToken','ownerQQ','botQQ'].map(k => [k, $(k).value])); input.exclusive = $('exclusive').checked; await action('connect', [input]); $('dshToken').value = ''; $('qqToken').value = ''; });
$('disconnect').addEventListener('click', () => action('disconnect', []));
$('reconnect').addEventListener('click', () => action('reconnect', []));
refresh(); setInterval(() => { if (!busy) refresh(); }, 1500);
