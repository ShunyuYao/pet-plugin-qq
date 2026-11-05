'use strict';
(()=>{
  const $=id=>document.getElementById('d-'+id),call=(method,...args)=>window.pet.services.invoke('qq-context',method,args);
  const names={idle:'尚未配置官方私聊',connecting:'正在连接本人私聊',connected:'本人私聊已连接',reconnecting:'腾讯 SDK 正在恢复私聊',paused:'私聊已暂停',offline:'私聊连接失败 / 已停止'};
  const jobNames={queued:'排队',running:'生成中',sending:'发送中',completed:'已回复',unknown:'结果待核对，不重发',failed:'未完成'};
  let busy=false,localError='',selected=false,loaded=false;
  async function refresh(){try{
    const s=await call('directState');$('status').textContent=names[s.state]||s.state;$('error').textContent=localError||s.error||'';
    $('connect').hidden=s.configured;$('controls').hidden=!s.configured;
    if(s.configured&&!loaded){$('update-budget').value=s.modelCallsPerDay;loaded=true;}
    if(s.configured&&!selected&&['connecting','connected','reconnecting','offline'].includes(s.state)){selected=true;document.getElementById('mode-direct').click();}
    $('summary').textContent=s.configured?`AppID ${s.appId} · ${s.ownerLabel} · 收件 ${s.received} 条 · 已回复 ${s.completed} 条 · 今日模型 ${s.calls}/${s.modelCallsPerDay} 次 · 排队 ${s.pending} 条`:'先暂停群采集，再绑定本人私聊。';
    $('pause').disabled=busy||!['connecting','connected','reconnecting'].includes(s.state);$('resume').disabled=busy||['connecting','connected','reconnecting'].includes(s.state);
    $('jobs').replaceChildren(...s.jobs.map(row=>{const li=document.createElement('li');li.textContent=new Date(row.at).toLocaleString('zh-CN')+' · '+(jobNames[row.status]||row.status);return li;}));
  }catch(e){$('error').textContent=e.message;}}
  async function action(fn){if(busy)return;busy=true;localError='';try{await fn();}catch(e){localError=e.message;}finally{busy=false;await refresh();}}
  $('connect').onsubmit=e=>{e.preventDefault();void action(async()=>{const input={appId:$('app-id').value.trim(),appSecret:$('secret').value,ownerOpenId:$('owner').value.trim(),modelCallsPerDay:Number($('budget').value),confirmed:$('confirm').checked};$('secret').value='';await call('directConnect',input);});};
  $('pause').onclick=()=>action(()=>call('directPause'));$('resume').onclick=()=>action(()=>call('directResume'));
  $('update').onclick=()=>action(async()=>{const input={appSecret:$('update-secret').value,modelCallsPerDay:Number($('update-budget').value)};$('update-secret').value='';await call('directUpdate',input);});
  document.getElementById('mode-direct').addEventListener('click',()=>{void refresh();});
  void refresh();setInterval(()=>{if(!busy&&!document.getElementById('direct-mode').hidden)void refresh();},2000);
})();
