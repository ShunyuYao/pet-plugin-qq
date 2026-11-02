'use strict';
// Real production Electron, sandbox panel, utilityProcess, host Harness and
// encrypted persistence. Only model/SMS/OneBot transport are local fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fixtures,wait}=require('./fixtures.cjs');
const host=process.env.PET_PLUGIN_HOST_DIR;if(!host)throw Error('Set PET_PLUGIN_HOST_DIR to the candidate host demo directory');
const H=require(path.join(host,'../tests/e2e-helpers'));
const {activateButton,activateClosingButton}=require(path.join(host,'../tests/e2e/html-card-input'));
const port=Number(process.env.QQ_GROUP_CDP_PORT||9567),profile=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-pet-qq-feedback-'));
const artifact=path.resolve(__dirname,'../artifacts/group-'+Date.now());let child,f,pet,panel,chat;
const value=(target,expression)=>H.evalIn(target,expression);
const textOf=content=>typeof content==='string'?content:(content||[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
async function type(target,selector,text){const session=await H.openCdpSession(target);try{const send=(method,params)=>H.cdpSessionCommand(session,method,params);await send('Emulation.setFocusEmulationEnabled',{enabled:true});await send('Runtime.evaluate',{expression:`document.querySelector(${JSON.stringify(selector)}).focus()`});await send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:process.platform==='darwin'?4:2,commands:['selectAll']});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65});await send('Input.insertText',{text});}finally{session.ws.close();}}
async function check(selector){await value(panel,`document.querySelector(${JSON.stringify(selector)}).focus()`);for(const type of ['keyDown','keyUp'])await H.cdp(panel,'Input.dispatchKeyEvent',{type,key:' ',code:'Space',windowsVirtualKeyCode:32});}
async function start(){child=H.launch({userData:profile,cdpPort:port,bootstrap:path.join(host,'../tests/helpers/appearance-hidden-bootstrap.js'),env:{PET_E2E_TEST:'1',PET_E2E_HIDDEN:'1',PET_E2E_BACKGROUND:'1',PET_E2E_USE_MOCK_KEYCHAIN:'1',PET_PUBLIC_NATIVE_LOG:path.join(artifact,'native.jsonl'),PET_E2E_ENV_CONFIG:JSON.stringify({test:{accountApiBase:f.base+'/api',analyticsEvents:'',agentTrace:'',diagnostics:''}})}});
 const login=await H.findReadyTarget(port,'trial-entry.html','trialAccess').catch(()=>null);if(login){await type(login,'#phone','19977776661');await type(login,'#sms','123456');await activateButton(login,'.primary',{capture:false});await H.waitTargetGone(port,'trial-entry.html');}pet=await H.findTarget(port,'/index.html');await wait(()=>value(pet,'!!window.petAPI'),'pet API');}
async function openPanel(){await value(pet,"petAPI.togglePluginPanel('qq-context')");panel=await H.findReadyTarget(port,'/panel/index.html','pet');}
async function openChat(){await value(pet,'petAPI.openChatWindow()');chat=await H.findTarget(port,'/chat.html');await wait(()=>value(chat,'!!document.querySelector(".cp-input input")'),'chat input');await activateButton(chat,'.cp-toggle',{capture:false});}
async function send(text){await type(chat,'.cp-input input',text);for(const type of ['keyDown','keyUp'])await H.cdp(chat,'Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});}
const call=(method,...args)=>value(panel,`pet.services.invoke('qq-context',${JSON.stringify(method)},${JSON.stringify(args)})`);
(async()=>{
 try{
  fs.mkdirSync(artifact,{recursive:true});
  f=await fixtures({model:async body=>{
    const text=textOf(body.messages.findLast(row=>row.role==='user'&&!textOf(row.content).startsWith('Current runtime context.'))?.content);
    if(text.includes('你是吐梨邦产品反馈整理员')){
      const messages=JSON.parse(/<group_data>([\s\S]*)<\/group_data>/.exec(text)[1]);const source=messages.find(m=>m.text.includes('设置页'));
      return {role:'assistant',content:JSON.stringify({feedback:source?[{type:'bug',title:'设置页打不开',description:'用户报告 Windows 上点击设置页没有反应',platform:'Windows',version:null,reproduction:'点击设置页',sourceIds:[source.key]}]:[]})};
    }
    if(text.includes('<trigger>'))return {role:'assistant',content:'刚才群里报告了设置页打不开，版本信息还需要补充。'};
    const lastTool=body.messages.findLast(row=>row.role==='tool');
    if(lastTool){const wire=textOf(lastTool.content);if(wire.includes('sources')&&wire.includes('Windows 上点击设置页没有反应'))return {role:'assistant',content:'今天群里有一条 bug：设置页打不开。来源是群 80001、消息 601；用户原话是 Windows 上点击设置页没有反应。'};const id=/fb-[a-f0-9]{20}/.exec(wire)?.[0];if(id)return {role:'assistant',tool_calls:[{id:'query-source',type:'function',function:{name:'qq_feedback_query',arguments:JSON.stringify({feedbackId:id})}}]};return {role:'assistant',content:'工具未返回原话证据：'+wire};}
    if(text.includes('今天群里有哪些 bug'))return {role:'assistant',tool_calls:[{id:'query-feedback',type:'function',function:{name:'qq_feedback_query',arguments:JSON.stringify({type:'bug',today:true})}}]};
    return {role:'assistant',content:'已经记下桌面私人暗号。'};
  }});
  const dir=path.join(profile,'plugins/qq-context');fs.mkdirSync(dir,{recursive:true});for(const file of ['manifest.json','index.cjs','src','panel','node_modules'])fs.cpSync(path.resolve(__dirname,'..',file),path.join(dir,file),{recursive:true});
  const manifest=require('../manifest.json');fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify({onboarding:{completed:true},character:'qiqi',tts:{enabled:false},general:{autoCheckUpdates:false},relay:{url:''},ai:{source:'byok',apiKey:'synthetic-model-key',baseUrl:f.base+'/v1',model:'mock'},plugins:{registrySources:[f.base],grants:{'qq-context':{granted:[...manifest.permissions,'service:qq-context']}}}}));fs.writeFileSync(profile+'.environment-selection.json',JSON.stringify({environment:'test'}));
  await start();await openChat();await send('桌面私人暗号 PRIVATE_ONLY_SENTINEL');await wait(()=>value(chat,'document.body.textContent.includes("已经记下桌面私人暗号")'),'private main chat');await activateClosingButton(port,chat,'.cp-close');chat=null;
  await openPanel();await wait(()=>value(panel,'document.querySelector("#g-status").textContent.includes("尚未配置")'),'group configuration');
  for(const [id,text] of Object.entries({'g-url':f.config.qqUrl,'g-token':f.config.qqToken,'g-bot':f.config.botQQ,'g-groups':'80001,80002','g-retention':'7','g-capacity':'5000','g-budget':'20'}))await type(panel,'#'+id,text);
  for(const id of ['#g-ai','#g-replies','#g-consent'])await check(id);
  await H.captureScreenshot(panel,path.join(artifact,'configuration.png'));await activateButton(panel,'#g-connect',{capture:false});await wait(()=>value(panel,'document.querySelector("#g-status").textContent==="正在采集群消息"'),'connected',25000);
  f.qqMessage(601,'Windows 上点击设置页没有反应',{message_type:'group',group_id:80001});
  for(let n=0;n<10;n++)f.qqMessage(602,'刚才是什么问题',{message_type:'group',group_id:80001,message:[{type:'at',data:{qq:'90002'}},{type:'text',data:{text:'刚才是什么问题'}}]});
  f.qqMessage(603,'其他群的秘密 CROSS_GROUP_SENTINEL',{message_type:'group',group_id:80002});
  f.qqMessage(604,'',{post_type:'notice',notice_type:'group_upload',group_id:80001,file:{id:'synthetic-file',name:'synthetic-report.txt',size:256}});
  await wait(()=>f.sent.length===1,'single @ reply',25000);assert.equal(f.sent[0].group_id,80001);assert.equal(f.sent[0].user_id,undefined);
  await wait(()=>value(panel,'document.querySelector("#g-message-list").textContent.includes("Windows 上点击设置页没有反应")'),'new original appears without manual refresh');
  await wait(()=>value(panel,'document.querySelector("#g-message-list").textContent.includes("synthetic-report.txt")'),'file upload notice is visible as metadata');
  await activateButton(panel,'#g-process',{capture:false});
  await wait(()=>value(panel,'!!document.querySelector("[data-feedback-id]")'),'feedback appears',30000);
  await activateButton(panel,'[data-feedback-id]',{capture:false});await wait(()=>value(panel,'document.querySelector("#g-feedback-sources").textContent.includes("Windows 上点击设置页没有反应")'),'original evidence');
  const id=await value(panel,'document.querySelector("[data-feedback-id]").dataset.feedbackId');
  await type(panel,'#g-feedback-title','设置页打不开（人工复核）');
  assert.equal(await value(panel,'document.querySelector("#g-feedback-title").value'),'设置页打不开（人工复核）','real input replaces title');
  await activateButton(panel,'#g-feedback-save',{capture:false});await wait(async()=> {await H.sleep(500);return (await call('groupFeedbackDetail',{id})).title==='设置页打不开（人工复核）';},'manual correction persisted');
  await activateButton(panel,'#g-feedback-confirm',{capture:false});await wait(async()=> {await H.sleep(500);return (await call('groupFeedbackDetail',{id})).status==='confirmed';},'manual confirmation persisted');
  await H.captureScreenshot(panel,path.join(artifact,'feedback-detail.png'));
  const before=f.sent.length;await openChat();await send('今天群里有哪些 bug？请给出来源原话。');
  await wait(()=>value(chat,'document.body.textContent.includes("来源是群 80001、消息 601")'),'desktop queries actual tool',25000);assert.equal(f.sent.length,before,'desktop query never sends to QQ');
  await H.captureScreenshot(chat,path.join(artifact,'desktop-query.png'));
  const groupRequests=f.modelRequests.filter(body=>body.messages.some(m=>/<group_data>/.test(textOf(m.content))));assert.ok(groupRequests.length>=2);
  for(const body of groupRequests){const wire=JSON.stringify(body);assert.ok(!wire.includes('PRIVATE_ONLY_SENTINEL'));assert.equal((body.tools||[]).length,0);if(wire.includes('<trigger>'))assert.ok(!wire.includes('CROSS_GROUP_SENTINEL'));}
  await activateButton(panel,'#g-pause',{capture:false});await wait(()=>value(panel,'document.querySelector("#g-status").textContent.includes("已暂停")'),'pause');
  await H.stopOwned(child);child=null;await start();await openPanel();await wait(()=>value(panel,'document.querySelector("#g-status").textContent.includes("已暂停")'),'paused state after restart');
  assert.equal((await call('groupFeedbackDetail',{id})).title,'设置页打不开（人工复核）');assert.equal(f.sent.length,before);
  await activateButton(panel,'#g-resume',{capture:false});await wait(()=>value(panel,'document.querySelector("#g-status").textContent==="正在采集群消息"'),'resume');
  f.qqMessage(601,'',{post_type:'notice',notice_type:'group_recall',group_id:80001,operator_id:90001});await wait(async()=> {await H.sleep(500);return (await call('groupFeedbackDetail',{id})).evidenceChanged;},'recall invalidates feedback');
  const recalled=await call('groupFeedbackDetail',{id});assert.equal(recalled.description,'');assert.equal(recalled.sources[0].text,'');
  await activateButton(panel,'#g-pause',{capture:false});
  fs.writeFileSync(path.join(artifact,'report.json'),JSON.stringify({passed:true,realElectron:true,groupUI:true,realQQLogin:false,modelSemanticQuality:false,qqDeliveries:f.sent.length,modelRequests:f.modelRequests.length,feedbackId:id,privateMemoryIsolated:true,profile,host},null,2));console.log('PASS',artifact);
 }catch(error){fs.mkdirSync(artifact,{recursive:true});fs.writeFileSync(path.join(artifact,'failure.txt'),String(error.stack)+'\n'+(child?.log||''));fs.writeFileSync(path.join(artifact,'model-requests.json'),JSON.stringify(f?.modelRequests||[],null,2));if(panel){fs.writeFileSync(path.join(artifact,'panel-debug.json'),JSON.stringify(await value(panel,'({body:document.body.innerText})').catch(()=>null),null,2));await H.captureScreenshot(panel,path.join(artifact,'failure.png')).catch(()=>{});}console.error(error);process.exitCode=1;}
 finally{if(child)await H.stopOwned(child);await f?.close();}
})();
