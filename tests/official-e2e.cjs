'use strict';
// Real hidden Electron, sandbox panel, utilityProcess, encrypted storage and
// production official normalization. Only QQ HTTP/WS and SMS are local fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {WebSocketServer}=require('ws');
const {fixtures,wait}=require('./fixtures.cjs');
const host=process.env.PET_PLUGIN_HOST_DIR;if(!host)throw Error('Set PET_PLUGIN_HOST_DIR to the candidate host demo');
const H=require(path.join(host,'../tests/e2e-helpers'));
const {activateButton,activateClosingButton}=require(path.join(host,'../tests/e2e/html-card-input'));
const privateMode=process.argv.includes('--private');
const port=Number(process.env.QQ_OFFICIAL_CDP_PORT||(privateMode?9575:9573)),profile=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-pet-qq-official-'));
const artifact=path.resolve(__dirname,'../artifacts/'+(privateMode?'private':'official')+'-e2e-'+Date.now());
const groupId='ABCDEF0123456789ABCDEF0123456789';
let child,f,server,wss,panel,base;const clients=new Set(),sentMessages=[];let sends=0,resumeFrames=0;
const value=(target,expression)=>H.evalIn(target,expression);
const call=(method,...args)=>value(panel,`pet.services.invoke('qq-context',${JSON.stringify(method)},${JSON.stringify(args)})`);
async function type(target,selector,text){await H.cdp(target,'Emulation.setFocusEmulationEnabled',{enabled:true});await value(target,`document.querySelector(${JSON.stringify(selector)}).focus()`);await H.cdp(target,'Input.insertText',{text});}
async function start(){
  child=H.launch({userData:profile,cdpPort:port,bootstrap:path.join(host,'../tests/helpers/appearance-hidden-bootstrap.js'),env:{PET_E2E_TEST:'1',PET_E2E_HIDDEN:'1',PET_E2E_BACKGROUND:'1',PET_E2E_USE_MOCK_KEYCHAIN:'1',PET_PUBLIC_NATIVE_LOG:path.join(artifact,'native.jsonl'),QQ_OFFICIAL_FIXTURE_BASE:base,PET_E2E_ENV_CONFIG:JSON.stringify({test:{accountApiBase:f.base+'/api',analyticsEvents:'',agentTrace:'',diagnostics:''}})}});
  const login=await H.findReadyTarget(port,'trial-entry.html','trialAccess').catch(()=>null);
  if(login){await type(login,'#phone','19977776661');await type(login,'#sms','123456');await activateButton(login,'.primary',{capture:false});await H.waitTargetGone(port,'trial-entry.html');}
  const pet=await H.findTarget(port,'/index.html');await value(pet,"petAPI.togglePluginPanel('qq-context')");panel=await H.findReadyTarget(port,'/panel/index.html','pet');
  await wait(()=>value(panel,'document.querySelector("#g-status").textContent!=="正在读取状态"'),'group state ready');
  assert.equal(await value(panel,'!!document.querySelector("#panel-close")'),true,'panel needs a visible exit control');
}
async function closeAndReopen(mode,method){
  const before=await call(method),connections=clients.size;
  for(const tab of ['direct','group','private']){
    await activateButton(panel,'#mode-'+tab,{capture:false});
    await value(panel,'window.scrollTo(0,document.documentElement.scrollHeight)');
    assert.equal(await value(panel,'(()=>{const r=document.querySelector("#panel-close").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&!document.querySelector("#panel-close").disabled;})()'),true,'close stays visible on '+tab);
  }
  await activateClosingButton(port,panel,'#panel-close');panel=null;
  assert.equal(clients.size,connections,'closing the panel must not stop the QQ transport');
  const pet=await H.findTarget(port,'/demo/index.html');await value(pet,"petAPI.togglePluginPanel('qq-context')");panel=await H.findReadyTarget(port,'/panel/index.html','pet');
  await activateButton(panel,'#mode-'+mode,{capture:false});
  const after=await call(method);assert.equal(after.state,before.state);assert.equal(after.messages??after.completed,before.messages??before.completed);
  assert.equal(clients.size,connections,'reopening the panel must not replace the connection');
  await H.captureScreenshot(panel,path.join(artifact,'panel-exit.png'));
}
function publish(id,text,patch={},type='GROUP_MESSAGE_CREATE'){
  const event={op:0,t:type,s:2,d:{id:'ROBOT1.0_'+id,group_openid:groupId,timestamp:new Date().toISOString(),author:{id:'MEMBER_FAKE_123',username:'合成用户'},content:text,message_scene:{ext:['auth_token=SCENE_TOKEN_NOT_FOR_STORAGE']},...patch}};
  for(const ws of clients)if(ws.readyState===1)ws.send(JSON.stringify(event));
}
async function privateScenario(){
  const owner='PRIVATE_OWNER_SYNTHETIC_123';
  await activateButton(panel,'#mode-direct',{capture:false});
  for(const [selector,text]of Object.entries({'#d-app-id':'1000000001','#d-secret':'SYNTHETIC_ONLY','#d-owner':owner,'#d-budget':'10'}))await type(panel,selector,text);
  await activateButton(panel,'#d-confirm',{capture:false,key:{key:' ',code:'Space',windowsVirtualKeyCode:32}});
  await activateButton(panel,'#d-connect button[type=submit]',{capture:false});
  await wait(()=>value(panel,'document.querySelector("#d-status").textContent==="本人私聊已连接"'),'owner private UI connected');
  publish('stranger','STRANGER_PRIVATE_CONTENT',{group_openid:undefined,author:{user_openid:'PRIVATE_STRANGER'}},'C2C_MESSAGE_CREATE');
  publish('group','GROUP_CONTEXT_NOT_FOR_PRIVATE');
  for(let n=0;n<10;n++)publish('owner','PRIVATE_OWNER_BODY',{group_openid:undefined,author:{user_openid:owner}},'C2C_MESSAGE_CREATE');
  await wait(()=>sentMessages.length===1,'single private reply',25000);
  await wait(async()=>(await call('directState')).completed===1,'private receipt saved');
  assert.equal(sentMessages[0].url,'/v2/users/'+owner+'/messages');assert.equal(sentMessages[0].body.msg_id,'ROBOT1.0_owner');assert.equal(sentMessages[0].body.msg_seq,1);
  assert.equal(sentMessages[0].body.content,'PRIVATE_MODEL_REPLY');assert.equal(f.modelRequests.length,1);
  const wire=JSON.stringify(f.modelRequests[0]);assert.ok(wire.includes('PRIVATE_OWNER_BODY'));assert.ok(!wire.includes('STRANGER_PRIVATE_CONTENT'));assert.ok(!wire.includes('GROUP_CONTEXT_NOT_FOR_PRIVATE'));assert.equal((f.modelRequests[0].tools||[]).length,0);
  const state=await call('directState');assert.equal(state.calls,1);assert.equal(state.received,1);assert.ok(!JSON.stringify(state).includes('PRIVATE_OWNER_BODY'));assert.ok(!JSON.stringify(state).includes('SYNTHETIC_ONLY'));
  assert.equal((await call('groupState')).messages,0);assert.equal((await call('groupState')).state,'disconnected');
  await assert.rejects(call('groupConnect',{provider:'official',appId:'1000000001',appSecret:'SYNTHETIC_ONLY',groupIds:[groupId],retentionDays:4,maxEvents:5000,collectionNoticeConfirmed:true}),/暂停官方私聊/);
  await wait(()=>value(panel,'document.querySelector("#d-summary").textContent.includes("已回复 1 条")'),'private reply status rendered');
  await H.captureScreenshot(panel,path.join(artifact,'private-reply.png'));
  await closeAndReopen('direct','directState');
  await activateButton(panel,'#d-pause',{capture:false});await wait(async()=>(await call('directState')).state==='paused','private paused');
  await H.stopOwned(child);child=null;await start();await activateButton(panel,'#mode-direct',{capture:false});
  assert.equal((await call('directState')).state,'paused');assert.equal((await call('directState')).completed,1);
  await activateButton(panel,'#d-resume',{capture:false});await wait(async()=>(await call('directState')).state==='connected','private resumed');
  publish('owner','PRIVATE_OWNER_BODY',{group_openid:undefined,author:{user_openid:owner}},'C2C_MESSAGE_CREATE');
  await wait(async()=>(await call('directState')).diagnostics?.privateMessages>=1,'replay seen after restart');
  await wait(async()=>(await call('directState')).pending===0,'replay processing finished');
  assert.equal(sentMessages.length,1);assert.equal(f.modelRequests.length,1);
  await activateButton(panel,'#d-pause',{capture:false});
  fs.writeFileSync(path.join(artifact,'report.json'),JSON.stringify({passed:true,realElectron:true,realQQ:false,officialSDKVersion:'1.0.5',privateOwnerOnly:true,passiveReplyToOriginalUser:true,noGroupProcessing:true,noTools:true,restartDedupe:true,modelCalls:f.modelRequests.length,sends,profile},null,2));
  console.log('PASS',artifact);
}
(async()=>{
 try{
  fs.mkdirSync(artifact,{recursive:true});f=await fixtures({model:async()=>({role:'assistant',content:'PRIVATE_MODEL_REPLY'})});
  server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;res.setHeader('content-type','application/json');
    if(req.url==='/app/getAppAccessToken')return res.end(JSON.stringify({access_token:'OFFICIAL_SYNTHETIC_TOKEN',expires_in:7200}));
    if(req.url==='/gateway')return res.end(JSON.stringify({url:'wss://api.bot.qq.com/websocket'}));
    if(req.method==='POST'&&req.url.includes('/messages')){sends++;sentMessages.push({url:req.url,body:JSON.parse(raw)});return res.end(JSON.stringify({id:'SYNTHETIC_SENT'}));}
    res.statusCode=404;res.end('{}');
  });wss=new WebSocketServer({server});
  wss.on('connection',ws=>{clients.add(ws);ws.on('close',()=>clients.delete(ws));ws.send(JSON.stringify({op:10,d:{heartbeat_interval:1000}}));ws.on('message',raw=>{const e=JSON.parse(String(raw));if(e.op===2)ws.send(JSON.stringify({op:0,t:'READY',s:1,d:{session_id:'fixture_session',user:{id:'BOT_FAKE_123'}}}));if(e.op===6){resumeFrames++;ws.send(JSON.stringify({op:0,t:'RESUMED',s:3,d:{}}));}if(e.op===1)ws.send(JSON.stringify({op:11}));});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
  const dir=path.join(profile,'plugins/qq-context');fs.mkdirSync(dir,{recursive:true});
  for(const file of ['manifest.json','index.cjs','src','panel','node_modules'])fs.cpSync(path.resolve(__dirname,'..',file),path.join(dir,file),{recursive:true});
  fs.renameSync(path.join(dir,'src/official-bot.cjs'),path.join(dir,'src/official-bot-production.cjs'));
  fs.copyFileSync(path.join(__dirname,'official-transport.fixture.cjs'),path.join(dir,'src/official-bot.cjs'));
  const manifest=require('../manifest.json');fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify({onboarding:{completed:true},character:'qiqi',tts:{enabled:false},general:{autoCheckUpdates:false},relay:{url:''},ai:{source:'byok',apiKey:'synthetic-private-model',baseUrl:f.base+'/v1',model:'mock'},plugins:{registrySources:[f.base],grants:{'qq-context':{granted:[...manifest.permissions,'service:qq-context']}}}}));
  fs.writeFileSync(profile+'.environment-selection.json',JSON.stringify({environment:'test'}));
  await start();if(privateMode){await privateScenario();return;}await call('groupConnect',{provider:'official',appId:'1000000001',appSecret:'SYNTHETIC_ONLY',groupIds:[groupId],retentionDays:4,maxEvents:5000,collectionNoticeConfirmed:true,automation:false,replyEnabled:false});
  await wait(()=>value(panel,'document.querySelector("#g-status").textContent==="正在采集群消息"'),'official collector online');
  for(let n=0;n<3;n++)publish('message_1','官方普通消息采集：设置页打不开');
  publish('foreign','FOREIGN_GROUP_CONTENT',{group_openid:'FEDCBA9876543210FEDCBA9876543210'});
  publish('invalid_time','REJECTED_INVALID_EVENT',{timestamp:'invalid'});
  publish('message_2','官方 @ 消息记录',{},'GROUP_AT_MESSAGE_CREATE');
  publish('private_1','PRIVATE_DIAGNOSTIC_ONLY',{group_openid:undefined,author:{user_openid:'PRIVATE_SENDER'}},'C2C_MESSAGE_CREATE');
  await wait(async()=>(await call('groupState')).messages===2,'two unique official messages saved');
  const state=await call('groupState');assert.equal(state.receiveDiagnostics.rejected,1);assert.equal(state.receiveDiagnostics.duplicates,2);assert.equal(state.receiveDiagnostics.gateway.ignoredGroupMessages,1);
  await wait(async()=>(await call('groupState')).receiveDiagnostics.gateway.privateMessages===1,'private receipt counted');
  assert.equal(state.receiveDiagnostics.gateway.transport,'tencent-sdk');
  const page=await call('groupMessages',{groupId});assert.equal(page.messages.length,2);assert.equal(sends,0,'recording must not send replies');
  assert.ok(!JSON.stringify(page).includes('SCENE_TOKEN_NOT_FOR_STORAGE'));assert.ok(!JSON.stringify(state.receiveDiagnostics).includes('FOREIGN_GROUP_CONTENT'));
  assert.ok(!JSON.stringify(page).includes('PRIVATE_DIAGNOSTIC_ONLY'));assert.ok(!JSON.stringify(state).includes('PRIVATE_SENDER'));
  await wait(()=>value(panel,'document.querySelector("#g-message-list").textContent.includes("官方普通消息采集：设置页打不开")'),'official OpenID query renders originals');
  assert.equal(await value(panel,'document.querySelector("#g-error").textContent'),'');
  await wait(()=>value(panel,'document.querySelector("#g-receive-status").textContent.includes("解析拒绝 1")'),'safe receive diagnostics rendered');
  await wait(()=>value(panel,'document.querySelector("#g-receive-status").textContent.includes("私聊到达 1")'),'private diagnostic receipt visible');
  for(const ws of clients)ws.send(JSON.stringify({op:7}));
  await wait(async()=>{const s=await call('groupState');return s.state==='collecting'&&s.receiveDiagnostics.gateway.connectedCount>=2;},'SDK resumes without manual reconnection');
  assert.ok(resumeFrames>=1,'real Tencent SDK sends opcode 6 RESUME');
  publish('message_1','官方普通消息采集：设置页打不开');
  await wait(async()=>(await call('groupState')).receiveDiagnostics.duplicates===3,'replayed event is deduplicated after SDK resume');
  await H.captureScreenshot(panel,path.join(artifact,'official-messages.png'));
  await closeAndReopen('group','groupState');
  const resumesBeforePause=resumeFrames;
  for(const ws of clients)ws.send(JSON.stringify({op:7}));
  await wait(async()=>(await call('groupState')).state==='reconnecting','SDK reconnect visible before pausing');
  await activateButton(panel,'#g-pause',{capture:false});await wait(async()=>(await call('groupState')).state==='paused','paused');
  await H.sleep(500);assert.equal(clients.size,0,'pause aborts scheduled SDK reconnect');assert.equal(resumeFrames,resumesBeforePause);
  await H.stopOwned(child);child=null;await start();await wait(async()=>(await call('groupState')).state==='paused','paused after restart');
  assert.equal((await call('groupMessages',{groupId})).messages.length,2,'official records survive fresh process');
  assert.equal(sends,0);fs.writeFileSync(path.join(artifact,'report.json'),JSON.stringify({passed:true,realElectron:true,realQQ:false,officialSDKVersion:'1.0.5',officialTransportFixture:true,queryByOpenId:true,originalsRendered:true,privateDiagnosticOnly:true,sdkResumeFrames:resumeFrames,diagnostics:true,restartPersistence:true,sends,profile},null,2));console.log('PASS',artifact);
 }catch(error){fs.mkdirSync(artifact,{recursive:true});const pages=await fetch('http://127.0.0.1:'+port+'/json').then(r=>r.json()).catch(()=>[]);fs.writeFileSync(path.join(artifact,'failure.txt'),String(error.stack)+'\n'+JSON.stringify({profile,exitCode:child?.exitCode,signalCode:child?.signalCode,pages:pages.map(p=>({title:p.title,url:p.url}))})+'\n'+(child?.log||''));console.error(error);process.exitCode=1;}
 finally{if(child)await H.stopOwned(child);for(const ws of clients)ws.terminate();wss?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await f?.close();}
})();
