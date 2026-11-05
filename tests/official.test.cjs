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
test('official SDK HTTP handles business failures, shares token refresh and never echoes server text', async t => {
  const originalFetch=globalThis.fetch,originalNow=Date.now;let now=100000,calls=[];
  Date.now=()=>now;t.after(()=>{globalThis.fetch=originalFetch;Date.now=originalNow;});
  const response=data=>({ok:true,status:200,statusText:'OK',headers:{get:()=>null},text:async()=>JSON.stringify(data)});
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return response(url.endsWith('/getAppAccessToken')?{access_token:'SYNTHETIC_TOKEN',expires_in:'7200'}:{url:'wss://api.bot.qq.com/websocket'});};
  const api=new OfficialAPI(config());
  await Promise.all([api.accessToken(),api.accessToken()]);assert.equal(calls.length,1);
  await api.request('/gateway');assert.equal(calls.at(-1).options.headers.Authorization,'QQBot SYNTHETIC_TOKEN');
  assert.match(calls.at(-1).options.headers['User-Agent'],/qqbot-nodejs\/1\.0\.5/);assert.equal(calls[0].url,'https://api.bot.qq.com/app/getAppAccessToken');
  now+=7201*1000;await api.accessToken();assert.equal(calls.filter(x=>x.url.endsWith('/getAppAccessToken')).length,2);api.close();
  globalThis.fetch=async()=>response({code:100016,message:secret});const broken=new OfficialAPI(config());
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
class Gateway {
  constructor(options){this.options=options;this.aborted=false;}
  start(){return new Promise((resolve,reject)=>{this.reject=reject;this.options.abortSignal.addEventListener('abort',()=>{this.aborted=true;resolve();},{once:true});queueMicrotask(()=>this.options.onReady({session_id:'fake_session',user:{id:'BOT_IDENTITY'}}));});}
  deliver(raw){this.options.onMessage({rawEventType:raw.t,kind:raw.t==='C2C_MESSAGE_CREATE'?'c2c':'group',groupOpenid:raw.d.group_openid,raw:raw.d});}
}
test('SDK adapter filters groups, records only private receipt counts, resumes and never retries replies', async()=>{
  const calls=[];const api={startRefresh:async()=>{},clearToken(){},accessToken:async()=>'FAKE_TOKEN',request:async(path,options)=>{calls.push({path,options});return path==='/gateway'?{url:'wss://api.bot.qq.com/websocket'}:{id:'SENT_FAKE'};},close(){this.closed=true;}};
  let gateway;const bot=new OfficialBot(config(),{api,gatewayFactory:async options=>gateway=new Gateway(options)});
  const events=[],seen=[];bot.on('group-event',e=>events.push(e));bot.on('group-seen',e=>seen.push(e));await bot.open();
  assert.equal(gateway.options.intents,1<<25);assert.equal(await gateway.options.getAccessToken(),'FAKE_TOKEN');assert.equal(gateway.options.reconnect.maxAttempts,3);
  assert.equal(await gateway.options.getGatewayUrl(),'wss://api.bot.qq.com/websocket');
  gateway.deliver(frame());gateway.deliver(frame('GROUP_MESSAGE_CREATE',{group_openid:'UNSELECTED_GROUP'}));
  gateway.deliver(frame('C2C_MESSAGE_CREATE',{content:'PRIVATE_NOT_FOR_GROUP',author:{user_openid:'PRIVATE_SENDER'}}));
  assert.equal(events.length,1);assert.equal(seen.length,2);assert.equal(calls.length,1,'receiving never sends');
  const diagnostics=bot.diagnostics();assert.equal(diagnostics.groupMessages,2);assert.equal(diagnostics.allowedGroupMessages,1);assert.equal(diagnostics.ignoredGroupMessages,1);
  assert.equal(diagnostics.privateMessages,1);assert.equal(diagnostics.transport,'tencent-sdk');
  assert.equal(diagnostics.lastMessageShape.timestampType,'string');
  assert.ok(!JSON.stringify(diagnostics).includes('设置打不开'));
  assert.ok(!JSON.stringify(diagnostics).includes('UNSELECTED_GROUP'));
  assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE_NOT_FOR_GROUP'));assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE_SENDER'));
  await assert.rejects(bot.sendGroup(groupId,'no trigger'),/触发/);
  const trigger=normalizeOfficialEvent(frame(),config());await bot.sendGroup(groupId,'已收到',trigger);
  assert.equal(calls.at(-1).options.body.msg_id,trigger.messageId);assert.equal(calls.at(-1).options.body.msg_seq,1);
  await assert.rejects(bot.sendGroup(groupId,'重复',trigger),/不会重发/);
  await assert.rejects(bot.sendGroup(groupId,'过期',{...trigger,messageId:'expired',occurredAt:Date.now()-301000}),/5分钟/);
  let reconnects=0,resumed=0;bot.on('reconnecting',()=>reconnects++);bot.on('reconnected',()=>resumed++);
  gateway.options.onDisconnected({willReconnect:true,code:4009,reason:secret});assert.equal(bot.ready,false);
  gateway.options.onResumed({});assert.equal(bot.ready,true);assert.equal(reconnects,1);assert.equal(resumed,1);assert.equal(bot.diagnostics().reconnects,1);
  bot.close();assert.equal(gateway.aborted,true);assert.equal(bot.ready,false);assert.equal(api.closed,true);
});
test('SDK adapter cancellation and timeout stop late startup without emitting a ready event',async()=>{
  let release;const wait=new Promise(r=>{release=r;});const api={startRefresh:()=>wait,close(){this.closed=true;}};
  const bot=new OfficialBot(config(),{api,startupTimeoutMs:20,gatewayFactory:async()=>{throw Error('must-not-start');}});
  await assert.rejects(bot.open(),/初次连接超时/);release();assert.equal(bot.closed,true);assert.equal(api.closed,true);
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
