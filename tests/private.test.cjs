'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {OfficialPrivate,validatePrivateConfig}=require('../src/official-private.cjs');
const {createGroupService}=require('../src/group-service.cjs');
const owner='OWNER_OPENID_SYNTHETIC_123';
const config=()=>({appId:'1000000001',appSecret:'SYNTHETIC_SECRET',ownerOpenId:owner,modelCallsPerDay:10,confirmed:true});
const event=(id='message_1',patch={})=>({messageId:id,senderId:owner,occurredAt:Date.now(),text:'PRIVATE_BODY_NOT_STORED',...patch});
function fixture(options={}){
  let scope={scopeId:'a',revision:1},bot,fail=false;const durable=new Map(),sent=[],prompts=[];
  const pet={profile:{getScope:async()=>({...scope})},secrets:{get:async k=>durable.get(k),set:async(k,v)=>{if(fail)throw Error('disk-full');durable.set(k,structuredClone(v));}}};
  const create=()=>new OfficialPrivate(pet,{authorize:async()=>{},canOpen:options.canOpen||(async()=>{}),minGap:options.minGap??0,makeBot:c=>{
    bot=new EventEmitter();bot.config=c;bot.open=async()=>{bot.ready=true;};bot.close=()=>{bot.ready=false;};
    bot.sendPrivate=async(target,text,trigger)=>{sent.push({target,text,id:trigger.messageId});if(options.unknownSend)throw Error('unknown');return 'receipt';};
    return bot;
  },runModel:async(text,signal)=>{prompts.push(text);return options.model?options.model(text,signal):'PRIVATE_REPLY_NOT_STORED';}});
  const service=create();return {pet,service,create,durable,sent,prompts,bot:()=>bot,fail:v=>{fail=v;},scope:v=>{scope=v;}};
}
test('private configuration requires explicit owner OpenID, budget and consent',()=>{
  for(const patch of [{ownerOpenId:'123456789'},{ownerOpenId:'../owner'},{confirmed:false},{modelCallsPerDay:0},{modelCallsPerDay:501},{appSecret:''}])assert.throws(()=>validatePrivateConfig({...config(),...patch}));
  assert.equal(validatePrivateConfig(config()).ownerOpenId,owner);
});
test('private replies go only to the owner; replay is deduplicated and plaintext never reaches storage',async()=>{
  const f=fixture();try{await f.service.connect(config());
    f.bot().emit('private-event',event('foreign',{senderId:'OTHER_USER'}));f.bot().emit('group-event',{text:'GROUP_MUST_NOT_CALL_MODEL'});
    for(let n=0;n<10;n++)f.bot().emit('private-event',event());await f.service.tasks;
    assert.equal(f.prompts.length,1);assert.equal(f.sent.length,1);assert.equal(f.sent[0].target,owner);
    const state=await f.service.status();assert.equal(state.completed,1);assert.equal(state.calls,1);
    const wire=JSON.stringify([...f.durable.values()]);assert.ok(!wire.includes('PRIVATE_BODY_NOT_STORED'));assert.ok(!wire.includes('PRIVATE_REPLY_NOT_STORED'));
    assert.ok(!JSON.stringify(state).includes('SYNTHETIC_SECRET'));assert.ok(!JSON.stringify(state).includes(owner));
    await f.service.pause();await f.service.resume();f.bot().emit('private-event',event());await f.service.tasks;
    assert.equal(f.sent.length,1);assert.deepEqual(f.bot().config.groupIds,[]);
    await assert.rejects(f.service.update({modelCallsPerDay:20}),/暂停/);await f.service.pause();await f.service.update({modelCallsPerDay:20,appSecret:'NEW_SYNTHETIC_SECRET'});
    assert.equal((await f.service.status()).modelCallsPerDay,20);assert.equal((await f.service.status()).received,1);
  }finally{f.service.dispose();}
});
test('private unknown sends survive fresh service restore and never replay',async()=>{
  const f=fixture({unknownSend:true});let restored;
  try{await f.service.connect(config());f.bot().emit('private-event',event());await f.service.tasks;
    assert.equal((await f.service.status()).jobs[0].status,'unknown');f.service.dispose();
    restored=f.create();await restored.restore();f.bot().emit('private-event',event());await restored.tasks;
    assert.equal(f.sent.length,1);assert.equal(f.prompts.length,1);
  }finally{f.service.dispose();restored?.dispose();}
});
test('pausing or changing scope while a private model runs prevents delivery',async()=>{
  let release;const f=fixture({model:()=>new Promise(r=>{release=r;})});
  try{await f.service.connect(config());f.bot().emit('private-event',event());
    for(let n=0;n<20&&!release;n++)await new Promise(r=>setImmediate(r));assert.ok(release);
    await f.service.pause();release('late');await f.service.tasks;assert.equal(f.sent.length,0);
    await f.service.resume();assert.equal((await f.service.status()).jobs[0].status,'unknown');
    f.scope({scopeId:'b',revision:2});await assert.rejects(f.service.status(),/身份/);await f.service.contextChanged();
    assert.equal((await f.service.status()).configured,false);assert.equal(f.sent.length,0);
  }finally{f.service.dispose();}
});
test('private budgets, failed writes and corrupt envelopes fail closed',async()=>{
  const f=fixture();try{await f.service.connect({...config(),modelCallsPerDay:1});f.bot().emit('private-event',event());await f.service.tasks;
    f.bot().emit('private-event',event('message_2'));await f.service.tasks;assert.equal(f.prompts.length,1);assert.match((await f.service.status()).error,/预算/);
    f.fail(true);f.bot().emit('private-event',event('message_3'));await f.service.tasks;assert.equal(f.service.state,'offline');assert.equal(f.sent.length,1);
    f.fail(false);await f.service.pause();f.service.envelope=null;const key=f.service.key();f.durable.set(key,{version:99,config:config()});
    await assert.rejects(f.service.restore(),/数据格式/);assert.equal(f.durable.get(key).version,99);
  }finally{f.service.dispose();}
});
test('private model error details are not echoed to UI or persistent ledger',async()=>{
  const f=fixture({model:async()=>{throw Error('API_KEY_SECRET 预算 response body');}});
  try{await f.service.connect(config());f.bot().emit('private-event',event());await f.service.tasks;
    assert.ok(!JSON.stringify(await f.service.status()).includes('API_KEY_SECRET'));assert.ok(!JSON.stringify([...f.durable.values()]).includes('API_KEY_SECRET'));
  }finally{f.service.dispose();}
});
test('pausing during the private rate gap aborts the waiting model call',async()=>{
  const f=fixture({minGap:1000});try{await f.service.connect(config());f.bot().emit('private-event',event());await f.service.tasks;
    f.bot().emit('private-event',event('second'));for(let n=0;n<30&&f.service.envelope.ledger.length<2;n++)await new Promise(r=>setImmediate(r));
    assert.equal(f.service.envelope.ledger.length,2);await f.service.pause();await f.service.tasks;assert.equal(f.prompts.length,1);assert.equal(f.sent.length,1);
  }finally{f.service.dispose();}
});
test('official private service blocks foreign callers and cannot overlap group discovery',async()=>{
  const f=fixture();const service=createGroupService(f.pet);const caller={sdkCaller:{kind:'plugin',id:'qq-context',context:'panel'}};
  try{await service.start();await assert.rejects(service.api.directState({sdkCaller:{kind:'plugin',id:'other',context:'panel'}}),/面板/);
    const state=await service.api.directState(caller);assert.equal(state.configured,false);
  }finally{service.dispose();f.service.dispose();}
});
