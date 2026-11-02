'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {GroupStore}=require('../src/group-store.cjs');
const {FeedbackRepository,validateItems}=require('../src/group-feedback.cjs');
const {GroupWorker,isolatedModel}=require('../src/group-worker.cjs');
const {normalizeGroupEvent,validateGroupConfig}=require('../src/group-events.cjs');
const cfg=validateGroupConfig({qqUrl:'ws://127.0.0.1:3001',botQQ:'90002',groupIds:['80001','80002'],retentionDays:7,maxEvents:5000,collectionNoticeConfirmed:true,automation:true,replyEnabled:true,modelCallsPerDay:20});
const event=(id,text,options={})=>normalizeGroupEvent({post_type:'message',message_type:'group',sub_type:'normal',self_id:90002,group_id:80001,user_id:90001,message_id:id,time:1700000000,message:[{type:'text',data:{text}}],...options},cfg,1700000000000);
const candidate=key=>({type:'bug',title:'设置打不开',description:'用户报告点击设置没有反应',platform:null,version:null,reproduction:null,sourceIds:[key]});
async function fixture(runModel,options={}){
  let data=null,now=1700000000000;
  const store=new GroupStore({scopeId:'scope',load:async()=>data,save:async next=>{data=structuredClone(next);},retentionDays:7,maxEvents:5000,now:()=>now});await store.open();
  const sends=[];const collector={state:'collecting',qq:{sendGroup:async(groupId,text)=>{sends.push({groupId,text});return 'receipt';}}};
  const worker=new GroupWorker({config:cfg,store,collector,current:async()=>true,runModel,now:()=>now,minGap:0,extractionDelay:0,...options});
  return {store,worker,repo:new FeedbackRepository(store),sends,data:()=>data,setNow:value=>{now=value;}};
}
test('feedback extraction accepts only bounded source-backed candidates; no invented citations',()=>{
  assert.equal(validateItems(JSON.stringify({feedback:[candidate('key')]}),['key'])[0].platform,null);
  assert.throws(()=>validateItems(JSON.stringify({feedback:[candidate('other-group')]}),['key']),/依据/);
  assert.throws(()=>validateItems(JSON.stringify({feedback:[{...candidate('key'),version:5}]}),['key']),/字段/);
  assert.deepEqual(validateItems('{"feedback":[]}',[]),[]);
});
test('ordinary group feedback is extracted without public replies; retry never duplicates completed evidence',async()=>{
  const row=event(1,'设置打不开');const f=await fixture(async()=>JSON.stringify({summary:'本群讨论设置故障',feedback:[candidate(row.key)]}));
  await f.store.append(row);await f.worker.tick();assert.equal(f.sends.length,0);
  const result=await f.repo.list();assert.equal(result.items.length,1);assert.equal(result.items[0].status,'pending');
  const detail=await f.repo.detail(result.items[0].id);assert.equal(detail.sources[0].text,'设置打不开');
  assert.equal((await f.repo.summaries('80001'))[0].text,'本群讨论设置故障');assert.equal((await f.repo.summaries('80002')).length,0);
  await f.repo.update({id:detail.id,status:'confirmed',title:'人工纠正标题'});assert.equal((await f.repo.detail(detail.id)).title,'人工纠正标题');
  assert.equal(await f.repo.retry('80001'),0);await f.store.append(row);await f.worker.tick();assert.equal((await f.repo.list()).items.length,1);
  const split=await f.repo.split({id:detail.id,title:'另一个问题',description:'人工拆分的另一处异常',sourceIds:[row.key]});assert.equal((await f.repo.list()).items.length,2);assert.deepEqual((await f.repo.detail(split.id)).relatedIds,[detail.id]);
  await assert.rejects(f.repo.split({id:detail.id,title:'跨群',description:'不可用',sourceIds:['another-group']}),/依据/);
});
test('real @ is answered once only in original group and takes priority over extraction',async()=>{
  let prompts=[];const f=await fixture(async prompt=>{prompts.push(prompt);return '只回复当前群';});
  await f.store.append(event(1,'其他群秘密',{group_id:80002}));
  await f.store.append(event(2,'问题背景'));
  const row=event(3,'请回答',{message:[{type:'at',data:{qq:'90002'}},{type:'text',data:{text:'请回答'}}]});
  await f.store.append(row);await f.worker.tick();assert.deepEqual(f.sends,[{groupId:'80001',text:'只回复当前群'}]);
  assert.ok(!prompts[0].includes('其他群秘密'));assert.ok(prompts[0].includes('问题背景'));
  await f.store.append(row);assert.equal((await f.repo.pending()).chat,undefined);
});
test('unknown send outcome survives restart and is never replayed; feedback failure is retryable separately',async()=>{
  const f=await fixture(async()=> '回答');f.worker.collector.qq.sendGroup=async()=>{throw Error('receipt-lost');};
  const row=event(1,'问候',{message:[{type:'at',data:{qq:'90002'}}]});await f.store.append(row);await f.worker.tick();
  assert.equal(f.data().jobs[0].status,'unknown');await f.repo.recover();assert.equal((await f.repo.pending()).chat,undefined);
  f.worker.runModel=async()=>{throw Error('model-offline');};await f.worker.tick();assert.equal((await f.repo.progress()).failed,1);
  await f.repo.retry('80001');assert.equal((await f.repo.progress()).pending,1);assert.equal(f.data().jobs[0].status,'unknown');
});
test('recall invalidates generated evidence and blocks stale model replies, budget persists conservatively',async()=>{
  const row=event(1,'设置打不开');const f=await fixture(async()=>JSON.stringify({summary:'已报告设置页打不开',feedback:[candidate(row.key)]}));await f.store.append(row);await f.worker.tick();
  await f.store.append({kind:'recall',key:row.key,groupId:row.groupId,botId:row.botId,messageId:row.messageId,receivedAt:1700000000000,occurredAt:1700000001000});
  const detail=await f.repo.detail((await f.repo.list()).items[0].id);assert.equal(detail.evidenceChanged,true);assert.equal(detail.description,'');assert.equal(detail.sources[0].text,'');
  await assert.rejects(f.repo.update({id:detail.id,title:'restore withdrawn evidence'}),/失效/);
  await f.repo.reserve(2);await assert.rejects(f.repo.reserve(2),/预算/);
  assert.ok(!JSON.stringify(f.data()).includes('用户报告点击设置没有反应'));
  assert.equal((await f.repo.summaries('80001')).length,0);
});
test('identity change or pause during model generation prevents group delivery',async()=>{
  let active=true;
  const f=await fixture(async()=>{active=false;return 'must not send';},{current:async()=>active});
  await f.store.append(event(1,'问候',{message:[{type:'at',data:{qq:'90002'}}]}));await f.worker.tick();assert.equal(f.sends.length,0);
});
test('cancellation while the SDK accepts a task cancels the returned task before polling',async()=>{
  const controller=new AbortController();let cancelled=null;
  const pet={ai:{start:async()=>{controller.abort(Error('paused'));return {id:'accepted'};},cancel:async id=>{cancelled=id;},get:async()=>{throw Error('must not poll');}}};
  await assert.rejects(isolatedModel(pet,'prompt',controller.signal),/paused/);assert.equal(cancelled,'accepted');
});
