'use strict';
// Real hidden Electron, sandbox panel, utilityProcess, encrypted storage and
// production official normalization. Only QQ HTTP/WS and SMS are local fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {WebSocketServer}=require('ws');
const {fixtures,wait}=require('./fixtures.cjs');
const host=process.env.PET_PLUGIN_HOST_DIR;if(!host)throw Error('Set PET_PLUGIN_HOST_DIR to the candidate host demo');
const H=require(path.join(host,'../tests/e2e-helpers'));
const {activateButton}=require(path.join(host,'../tests/e2e/html-card-input'));
const port=Number(process.env.QQ_OFFICIAL_CDP_PORT||9573),profile=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-pet-qq-official-'));
const artifact=path.resolve(__dirname,'../artifacts/official-e2e-'+Date.now());
const groupId='ABCDEF0123456789ABCDEF0123456789';
let child,f,server,wss,panel,base;const clients=new Set();let sends=0;
const value=(target,expression)=>H.evalIn(target,expression);
const call=(method,...args)=>value(panel,`pet.services.invoke('qq-context',${JSON.stringify(method)},${JSON.stringify(args)})`);
async function type(target,selector,text){await H.cdp(target,'Emulation.setFocusEmulationEnabled',{enabled:true});await value(target,`document.querySelector(${JSON.stringify(selector)}).focus()`);await H.cdp(target,'Input.insertText',{text});}
async function start(){
  child=H.launch({userData:profile,cdpPort:port,bootstrap:path.join(host,'../tests/helpers/appearance-hidden-bootstrap.js'),env:{PET_E2E_TEST:'1',PET_E2E_HIDDEN:'1',PET_E2E_BACKGROUND:'1',PET_E2E_USE_MOCK_KEYCHAIN:'1',PET_PUBLIC_NATIVE_LOG:path.join(artifact,'native.jsonl'),QQ_OFFICIAL_FIXTURE_BASE:base,PET_E2E_ENV_CONFIG:JSON.stringify({test:{accountApiBase:f.base+'/api',analyticsEvents:'',agentTrace:'',diagnostics:''}})}});
  const login=await H.findReadyTarget(port,'trial-entry.html','trialAccess').catch(()=>null);
  if(login){await type(login,'#phone','19977776661');await type(login,'#sms','123456');await activateButton(login,'.primary',{capture:false});await H.waitTargetGone(port,'trial-entry.html');}
  const pet=await H.findTarget(port,'/index.html');await value(pet,"petAPI.togglePluginPanel('qq-context')");panel=await H.findReadyTarget(port,'/panel/index.html','pet');
  await wait(()=>value(panel,'document.querySelector("#g-status").textContent!=="正在读取状态"'),'group state ready');
}
function publish(id,text,patch={},type='GROUP_MESSAGE_CREATE'){
  const event={op:0,t:type,s:2,d:{id:'ROBOT1.0_'+id,group_openid:groupId,timestamp:new Date().toISOString(),author:{id:'MEMBER_FAKE_123',username:'合成用户'},content:text,message_scene:{ext:['auth_token=SCENE_TOKEN_NOT_FOR_STORAGE']},...patch}};
  for(const ws of clients)if(ws.readyState===1)ws.send(JSON.stringify(event));
}
(async()=>{
 try{
  fs.mkdirSync(artifact,{recursive:true});f=await fixtures();
  server=http.createServer(async(req,res)=>{for await(const _ of req){}res.setHeader('content-type','application/json');
    if(req.url==='/app/getAppAccessToken')return res.end(JSON.stringify({access_token:'OFFICIAL_SYNTHETIC_TOKEN',expires_in:7200}));
    if(req.url==='/gateway')return res.end(JSON.stringify({url:'wss://api.bot.qq.com/websocket'}));
    if(req.method==='POST'&&req.url.includes('/messages')){sends++;return res.end(JSON.stringify({id:'SYNTHETIC_SENT'}));}
    res.statusCode=404;res.end('{}');
  });wss=new WebSocketServer({server});
  wss.on('connection',ws=>{clients.add(ws);ws.on('close',()=>clients.delete(ws));ws.send(JSON.stringify({op:10,d:{heartbeat_interval:1000}}));ws.on('message',raw=>{const e=JSON.parse(String(raw));if(e.op===2)ws.send(JSON.stringify({op:0,t:'READY',s:1,d:{session_id:'fixture_session',user:{id:'BOT_FAKE_123'}}}));if(e.op===1)ws.send(JSON.stringify({op:11}));});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
  const dir=path.join(profile,'plugins/qq-context');fs.mkdirSync(dir,{recursive:true});
  for(const file of ['manifest.json','index.cjs','src','panel','node_modules'])fs.cpSync(path.resolve(__dirname,'..',file),path.join(dir,file),{recursive:true});
  fs.renameSync(path.join(dir,'src/official-bot.cjs'),path.join(dir,'src/official-bot-production.cjs'));
  fs.copyFileSync(path.join(__dirname,'official-transport.fixture.cjs'),path.join(dir,'src/official-bot.cjs'));
  const manifest=require('../manifest.json');fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify({onboarding:{completed:true},character:'qiqi',tts:{enabled:false},general:{autoCheckUpdates:false},relay:{url:''},ai:{source:'byok',apiKey:''},plugins:{registrySources:[f.base],grants:{'qq-context':{granted:[...manifest.permissions,'service:qq-context']}}}}));
  fs.writeFileSync(profile+'.environment-selection.json',JSON.stringify({environment:'test'}));
  await start();await call('groupConnect',{provider:'official',appId:'1000000001',appSecret:'SYNTHETIC_ONLY',groupIds:[groupId],retentionDays:4,maxEvents:5000,collectionNoticeConfirmed:true,automation:false,replyEnabled:false});
  await wait(()=>value(panel,'document.querySelector("#g-status").textContent==="正在采集群消息"'),'official collector online');
  for(let n=0;n<3;n++)publish('message_1','官方普通消息采集：设置页打不开');
  publish('foreign','FOREIGN_GROUP_CONTENT',{group_openid:'FEDCBA9876543210FEDCBA9876543210'});
  publish('invalid_time','REJECTED_INVALID_EVENT',{timestamp:'invalid'});
  publish('message_2','官方 @ 消息记录',{},'GROUP_AT_MESSAGE_CREATE');
  await wait(async()=>(await call('groupState')).messages===2,'two unique official messages saved');
  const state=await call('groupState');assert.equal(state.receiveDiagnostics.rejected,1);assert.equal(state.receiveDiagnostics.duplicates,2);assert.equal(state.receiveDiagnostics.gateway.ignoredGroupMessages,1);
  const page=await call('groupMessages',{groupId});assert.equal(page.messages.length,2);assert.equal(sends,0,'recording must not send replies');
  assert.ok(!JSON.stringify(page).includes('SCENE_TOKEN_NOT_FOR_STORAGE'));assert.ok(!JSON.stringify(state.receiveDiagnostics).includes('FOREIGN_GROUP_CONTENT'));
  await wait(()=>value(panel,'document.querySelector("#g-message-list").textContent.includes("官方普通消息采集：设置页打不开")'),'official OpenID query renders originals');
  assert.equal(await value(panel,'document.querySelector("#g-error").textContent'),'');
  await wait(()=>value(panel,'document.querySelector("#g-receive-status").textContent.includes("解析拒绝 1")'),'safe receive diagnostics rendered');
  await H.captureScreenshot(panel,path.join(artifact,'official-messages.png'));
  await activateButton(panel,'#g-pause',{capture:false});await wait(async()=>(await call('groupState')).state==='paused','paused');
  await H.stopOwned(child);child=null;await start();await wait(async()=>(await call('groupState')).state==='paused','paused after restart');
  assert.equal((await call('groupMessages',{groupId})).messages.length,2,'official records survive fresh process');
  assert.equal(sends,0);fs.writeFileSync(path.join(artifact,'report.json'),JSON.stringify({passed:true,realElectron:true,realQQ:false,officialTransportFixture:true,queryByOpenId:true,originalsRendered:true,diagnostics:true,restartPersistence:true,sends,profile},null,2));console.log('PASS',artifact);
 }catch(error){fs.mkdirSync(artifact,{recursive:true});const pages=await fetch('http://127.0.0.1:'+port+'/json').then(r=>r.json()).catch(()=>[]);fs.writeFileSync(path.join(artifact,'failure.txt'),String(error.stack)+'\n'+JSON.stringify({profile,exitCode:child?.exitCode,signalCode:child?.signalCode,pages:pages.map(p=>({title:p.title,url:p.url}))})+'\n'+(child?.log||''));console.error(error);process.exitCode=1;}
 finally{if(child)await H.stopOwned(child);for(const ws of clients)ws.terminate();wss?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await f?.close();}
})();
