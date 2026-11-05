'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { OfficialAPI } = require('../src/official-api.cjs');
const { OfficialBot, gatewayURL } = require('../src/official-bot.cjs');
const { OfficialSetup } = require('../src/official-setup.cjs');
const { normalizeOfficialEvent } = require('../src/official-events.cjs');
const { validateGroupConfig } = require('../src/group-events.cjs');
const { GroupStore } = require('../src/group-store.cjs');
const { createGroupService } = require('../src/group-service.cjs');
const secret = 'SYNTHETIC_SECRET_NOT_A_REAL_KEY';
const groupId = 'ABCDEF0123456789ABCDEF0123456789';
const config = () => validateGroupConfig({ provider:'official', appId:'1906261291', appSecret:secret, groupIds:[groupId], retentionDays:7, maxEvents:5000, collectionNoticeConfirmed:true });
const frame = (type='GROUP_MESSAGE_CREATE', data={}) => ({ op:0,t:type,botIdentity:'BOT_IDENTITY',d:{id:'ROBOT1.0_fake_message',group_openid:groupId,timestamp:new Date().toISOString(),author:{id:'MEMBER_OPENID_123',username:'合成用户'},content:'设置打不开',...data} });
test('official config separates AppID identity from QQ and requires exact allowlist, notice and limits', () => {
  assert.equal(config().botQQ,'official-1906261291');
  for (const patch of [{appSecret:''},{groupIds:['12345']},{groupIds:[groupId,groupId]},{groupIds:['../../unsafe']},{collectionNoticeConfirmed:false},{retentionDays:0},{provider:'unknown'}]) assert.throws(()=>validateGroupConfig({...config(),...patch}));
  for (const url of ['ws://api.bot.qq.com/websocket','wss://evil.com','wss://api.bot.qq.com.evil.com','wss://user@api.bot.qq.com/websocket']) assert.throws(()=>gatewayURL(url));
  assert.equal(new URL(gatewayURL('wss://api.sgroup.qq.com/websocket')).hostname,'api.sgroup.qq.com');
});
test('official HTTP handles HTTP-200 business failures, shares token refresh and never echoes server text', async () => {
  let now=100000,calls=[];
  const api=new OfficialAPI(config(),{now:()=>now,fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.endsWith('/getAppAccessToken')?{access_token:'SYNTHETIC_TOKEN',expires_in:'7200'}:{url:'wss://api.bot.qq.com/websocket'}};}});
  await Promise.all([api.accessToken(),api.accessToken()]);assert.equal(calls.length,1);
  await api.request('/gateway');assert.equal(calls.at(-1).options.headers.Authorization,'QQBot SYNTHETIC_TOKEN');
  assert.equal(calls.at(-1).options.redirect,'error');assert.equal(calls[0].url,'https://api.bot.qq.com/app/getAppAccessToken');
  now+=7190*1000;await api.accessToken();assert.equal(calls.filter(x=>x.url.endsWith('/getAppAccessToken')).length,2);api.close();
  const broken=new OfficialAPI(config(),{fetchImpl:async()=>({ok:true,status:200,json:async()=>({code:100016,message:secret})})});
  await assert.rejects(broken.accessToken(),error=>error.message.includes('100016')&&!error.message.includes(secret));broken.close();
});
test('official normalization retains nontext and references but excludes auth tokens; detects @ precisely', async () => {
  const raw=frame('GROUP_MESSAGE_CREATE',{content:'@all 普通聊天',mentions:[{id:'OTHER_MEMBER'}],attachments:[{content_type:'image/png',filename:'fake.png',url:'https://example.invalid/fake.png'}],message_scene:{ext:['ref_msg_idx=REFIDX_fake','auth_token=SENSITIVE_SCENE_TOKEN']},msg_elements:[{content:'引用的原话',message_scene:{ext:['auth_token=SECRET_NESTED']}}]});
  const event=normalizeOfficialEvent(raw,config());assert.equal(event.mentioned,false);assert.deepEqual(event.replyTo,['REFIDX_fake']);
  assert.match(JSON.stringify(event),/image\/png/);assert.match(event.text,/引用的原话/);assert.ok(!JSON.stringify(event).includes('SENSITIVE_SCENE_TOKEN'));assert.ok(!JSON.stringify(event).includes('SECRET_NESTED'));
  assert.equal(normalizeOfficialEvent(frame('GROUP_AT_MESSAGE_CREATE'),config()).mentioned,true);
  assert.equal(normalizeOfficialEvent(frame('GROUP_MESSAGE_CREATE',{mentions:[{member_openid:'BOT_IDENTITY'}]}),config()).mentioned,true);
  assert.equal(normalizeOfficialEvent(frame('GROUP_AT_MESSAGE_CREATE',{author:{id:'BOT_IDENTITY',bot:true}}),config()).mentioned,false);
  assert.equal(normalizeOfficialEvent(frame('GROUP_MESSAGE_CREATE',{group_openid:'OTHER_GROUP_123'}),config()),null);
  let durable=null;const store=new GroupStore({scopeId:'scope-a',load:async()=>null,save:async v=>{durable=structuredClone(v);},retentionDays:7,maxEvents:5000});await store.open();
  await store.append(event);await store.append(event);assert.equal(durable.messages.length,1);assert.equal(durable.jobs.length,0);
  const mention=normalizeOfficialEvent({...raw,t:'GROUP_AT_MESSAGE_CREATE'},config());await store.append(mention);await store.append(mention);
  assert.equal(durable.messages.length,1);assert.equal(durable.jobs.length,1,'later @ upgrades original once without replaying jobs');
  const page=await store.query({groupId,botId:config().botQQ});
  assert.equal(page.messages.length,1,'saved official messages must be queryable by their opaque group OpenID');
  for(const invalid of ['../group','group:other','', 'a'.repeat(129)])await assert.rejects(store.query({groupId:invalid}),/invalid-group-query/);
});
class Socket extends EventEmitter {
  constructor(){super();this.readyState=1;this.sent=[];queueMicrotask(()=>this.emit('message',JSON.stringify({op:10,d:{heartbeat_interval:45000}})));}
  send(raw){const data=JSON.parse(raw);this.sent.push(data);if(data.op===2)queueMicrotask(()=>this.emit('message',JSON.stringify({op:0,t:'READY',s:1,d:{session_id:'fake_session',user:{id:'BOT_IDENTITY'}}})));}
  terminate(){this.readyState=3;}
}
test('official gateway authenticates with correct intent, filters groups, never sends proactive messages or retries', async()=>{
  const calls=[];const api={accessToken:async()=>'FAKE_TOKEN',request:async(path,options)=>{calls.push({path,options});return path==='/gateway'?{url:'wss://api.bot.qq.com/websocket'}:{id:'SENT_FAKE'};},close(){}};
  let socket;const bot=new OfficialBot(config(),{api,socketFactory:()=>socket=new Socket()});
  const events=[],seen=[];bot.on('group-event',e=>events.push(e));bot.on('group-seen',e=>seen.push(e));await bot.open();
  assert.equal(socket.sent[0].d.intents,1<<25);assert.equal(socket.sent[0].d.token,'QQBot FAKE_TOKEN');
  socket.emit('message',JSON.stringify(frame()));socket.emit('message',JSON.stringify(frame('GROUP_MESSAGE_CREATE',{group_openid:'UNSELECTED_GROUP'})));
  assert.equal(events.length,1);assert.equal(seen.length,2);assert.equal(calls.length,1,'receiving never sends');
  const diagnostics=bot.diagnostics();assert.equal(diagnostics.groupMessages,2);assert.equal(diagnostics.allowedGroupMessages,1);assert.equal(diagnostics.ignoredGroupMessages,1);
  assert.equal(diagnostics.lastMessageShape.timestampType,'string');
  assert.ok(!JSON.stringify(diagnostics).includes('设置打不开'));
  assert.ok(!JSON.stringify(diagnostics).includes('UNSELECTED_GROUP'));
  await assert.rejects(bot.sendGroup(groupId,'no trigger'),/触发/);
  const trigger=normalizeOfficialEvent(frame(),config());await bot.sendGroup(groupId,'已收到',trigger);
  assert.equal(calls.at(-1).options.body.msg_id,trigger.messageId);assert.equal(calls.at(-1).options.body.msg_seq,1);
  await assert.rejects(bot.sendGroup(groupId,'重复',trigger),/不会重发/);
  await assert.rejects(bot.sendGroup(groupId,'过期',{...trigger,messageId:'expired',occurredAt:Date.now()-301000}),/5分钟/);
  bot.close();assert.equal(socket.readyState,3);assert.equal(bot.ready,false);
});
test('official setup persists credentials only in secrets, discovers metadata only and stops on scope switch', async()=>{
  let scope={scopeId:'a',revision:1};const saved=new Map();let bot;
  const pet={profile:{getScope:async()=>({...scope})},secrets:{get:async k=>saved.get(k),set:async(k,v)=>saved.set(k,structuredClone(v))}};
  const setup=new OfficialSetup(pet,{makeBot:()=>{bot=new EventEmitter();bot.open=async()=>{};bot.close=()=>{bot.closed=true;};return bot;}});
  await setup.prepare({appId:'1906261291',appSecret:secret});await setup.pending;
  await assert.rejects(setup.prepare({appId:'1906261291',appSecret:secret}),/先停止/);
  assert.notEqual(bot.closed,true,'repeated preparation must not tear down a live gateway');
  bot.emit('group-seen',{groupId,eventType:'GROUP_MESSAGE_CREATE',at:Date.now(),content:'DO_NOT_KEEP'});await new Promise(r=>setImmediate(r));
  const status=await setup.status();assert.equal(status.state,'ready');assert.equal(status.hasSecret,true);assert.equal(status.groups[0].fullMessagesObserved,true);assert.ok(!JSON.stringify(status).includes(secret));assert.ok(!JSON.stringify(status).includes('DO_NOT_KEEP'));
  setup.stop();assert.equal(bot.closed,true);assert.equal((await setup.status()).groups.length,0);
  scope={scopeId:'b',revision:2};assert.equal((await setup.status()).hasSecret,false);assert.equal(await setup.saved(scope),undefined);
});
test('panel status never reveals official credentials; foreign services cannot start official setup',async()=>{
  const scope={scopeId:'a',revision:1},saved=new Map();
  const pet={profile:{getScope:async()=>scope},secrets:{get:async k=>saved.get(k),set:async(k,v)=>saved.set(k,v)}};
  const setup=new OfficialSetup(pet);saved.set(setup.key(scope),{appId:'1906261291',appSecret:secret});
  const service=createGroupService(pet),caller={sdkCaller:{kind:'plugin',id:'qq-context',context:'panel'}};
  try {await service.start();const state=await service.api.groupState(caller);assert.equal(state.official.hasSecret,true);assert.ok(!JSON.stringify(state).includes(secret));await assert.rejects(service.api.groupOfficialPrepare({}, {sdkCaller:{kind:'plugin',id:'evil',context:'panel'}}),/面板/);}finally{service.dispose();}
});
