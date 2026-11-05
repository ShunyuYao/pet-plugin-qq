'use strict';
(() => {
  const $ = id => document.getElementById('g-' + id);
  const call = (method, ...args) => window.pet.services.invoke('qq-context', method, args);
  let revision = null, loaded = false, busy = false, selected = null, feedbackNext = 0, messageNext = 0, pageGeneration = 0, feedbackCount = -1, messageCount = -1, evidenceRevision = 0;
  let officialConnection = false;
  const provider = () => $('provider').checked ? 'official' : 'onebot';
  function providerFields() {
    const official = provider() === 'official';
    for (const [name,enabled] of [['official-fields',official],['onebot-fields',!official]]) {
      $(name).hidden = !enabled; for (const field of $(name).querySelectorAll('input')) field.disabled = !enabled;
    }
    $('groups-label').textContent = official ? '指定群 OpenID（逗号分隔，或点击上方发现结果）' : '指定群号（逗号分隔）';
  }
  for (const id of ['provider','provider-onebot']) $(id).onchange = () => { $('groups').value=''; $('secret').value=''; if(provider()!=='official')void call('groupOfficialStop').catch(()=>{}); providerFields(); };
  const names = {disconnected:'尚未配置群采集',connecting:'正在验证机器人',reconnecting:'腾讯 SDK 正在自动恢复连接',collecting:'正在采集群消息',paused:'采集与模型任务已暂停',offline:'连接已断开 / 已停止采集'};
  const statuses = {pending:'待确认',confirmed:'已确认',ignored:'已忽略',in_progress:'处理中',resolved:'已解决'};
  const jobNames={queued:'排队',running:'生成中',sending:'发送中',completed:'已发送',failed:'失败',unknown:'结果待核对',cancelled:'已取消'};
  const el = (tag, text, className) => { const node=document.createElement(tag);node.textContent=text;if(className)node.className=className;return node; };
  const date = value => new Date(value).toLocaleString('zh-CN');
  const receiveStatus=el('p','','hint');receiveStatus.id='g-receive-status';$('progress').after(receiveStatus);
  for(const [field,limit]of Object.entries({platform:200,version:100,reproduction:2000}))$('feedback-'+field).maxLength=limit;
  const splitBox=el('details',''),splitSummary=el('summary','拆分为另一条反馈（保留原条目与证据）');splitBox.append(splitSummary);
  for(const [name,label]of [['title','新反馈标题'],['description','新反馈的问题或期望'],['keys','依据消息 key（逗号分隔，从下方来源复制）']]){const wrapper=el('label',label),input=el('input','');input.id='g-split-'+name;input.maxLength=name==='title'?120:3000;wrapper.append(input);splitBox.append(wrapper);}
  const splitButton=el('button','创建拆分反馈','secondary');splitButton.id='g-split';splitButton.type='button';splitBox.append(splitButton);$('feedback-sources').before(splitBox);
  const suggestions=el('p','','hint');suggestions.id='g-related-suggestions';$('feedback-related').after(suggestions);
  const confirmButton=el('button','标为已确认','secondary');confirmButton.id='g-feedback-confirm';confirmButton.type='button';$('feedback-save').after(confirmButton);
  const connectionBox=el('details','');connectionBox.append(el('summary','更新接入地址与令牌（先暂停，保留群数据）'));
  for(const [name,label]of [['url','NapCat 地址'],['token','新访问令牌（留空保持不变）']]){const wrapper=el('label',label),input=el('input','');wrapper.id='g-update-'+name+'-label';input.id='g-update-'+name;if(name==='token'){input.type='password';input.autocomplete='new-password';}wrapper.append(input);connectionBox.append(wrapper);}
  const clearTokenLabel=el('label','明确清空已保存的令牌','check'),clearToken=el('input','');clearToken.id='g-clear-token';clearToken.type='checkbox';clearTokenLabel.prepend(clearToken);connectionBox.append(clearTokenLabel);
  const connectionButton=el('button','保存接入配置','secondary');connectionButton.id='g-update-connection';connectionButton.type='button';connectionBox.append(connectionButton);$('controls').append(connectionBox);
  function clearView() { pageGeneration++; selected=null;loaded=false;feedbackNext=0;messageNext=0;feedbackCount=-1;for(const id of ['feedback-list','message-list','feedback-sources','jobs','official-groups'])$(id).replaceChildren();$('connection').reset();providerFields();$('feedback-editor').reset();for(const id of ['update-token','update-url','edit-budget'])$(id).value='';$('clear-token').checked=false;$('edit-ai').checked=false;$('edit-replies').checked=false;$('config-summary').textContent='';$('feedback-id').textContent='';$('feedback-editor').hidden=true;$('message-detail').hidden=true;$('message-detail').textContent=''; }
  for(const kind of ['direct','group','private'])document.getElementById('mode-'+kind).addEventListener('click',()=>{
    for(const other of ['direct','group','private']){document.getElementById(other+'-mode').hidden=kind!==other;document.getElementById('mode-'+other).setAttribute('aria-pressed',String(other===kind));}
  });
  async function action(operation) { if(busy)return;busy=true;$('error').textContent='';for(const node of document.querySelectorAll('#group-mode button'))node.disabled=true;try{await operation();}catch(error){$('error').textContent=error.message;}finally{busy=false;for(const node of document.querySelectorAll('#group-mode button'))node.disabled=false;await refresh();} }
  async function refresh() {
    try {
      const state=await call('groupState');
      if(revision!==state.viewRevision){clearView();revision=state.viewRevision;}
      const official = state.official || {};
      if (official.appId && !$('app-id').value) $('app-id').value = official.appId;
      $('secret').placeholder = official.hasSecret ? '已保存密钥；留空复用，不回显' : '只在本机凭据仓保存，不回显';
      const officialNames={idle:'尚未连接官方网关',connecting:'正在验证官方密钥与网关',reconnecting:'腾讯 SDK 正在自动恢复连接',ready:'官方连接成功，等待发现测试群（未采集原文）',offline:'官方连接失败 / 已断开'};
      $('official-status').textContent=(officialNames[official.state]||'尚未验证官方机器人')+(official.error?' · '+official.error:'')+(official.diagnostics?` · 腾讯 SDK ${official.diagnostics.sdkVersion} · 私聊到达 ${official.diagnostics.privateMessages} 条（仅诊断，不保存或回复）`:'');
      $('official-prepare').disabled=['connecting','ready','reconnecting'].includes(official.state);
      $('official-stop').disabled=!['connecting','ready','reconnecting'].includes(official.state);
      $('official-groups').replaceChildren(...(official.groups||[]).map(group=>{
        const button=el('button',`${group.groupId} · ${group.fullMessagesObserved?'已收到普通群消息':'仅确认群事件，尚未验证全量接收'} · 点击选入`,'record-button');button.type='button';button.onclick=()=>{const ids=$('groups').value.split(/[,，\s]+/).filter(Boolean);if(!ids.includes(group.groupId))ids.push(group.groupId);$('groups').value=ids.join(',');};return button;
      }));
      $('status').textContent=names[state.state]||state.state;
      $('connection').hidden=!!state.config;$('controls').hidden=!state.config;$('browser').hidden=!state.config;
      $('progress').textContent=`已记录 ${state.messages||0} 条 · 候选反馈 ${state.progress?.feedback||0} 条 · 待整理 ${state.progress?.pending||0} 条 · 失败 ${state.progress?.failed||0} 条 · 今日模型预留调用 ${state.progress?.calls||0} 次${state.processing?' · 正在处理':''}`;
      const incoming=state.receiveDiagnostics,gateway=incoming?.gateway;
      receiveStatus.textContent=gateway?`腾讯 SDK ${gateway.sdkVersion}：群消息 ${gateway.groupMessages} 条（全量事件 ${gateway.fullMessages}、@ 事件 ${gateway.atMessages}）；匹配授权群 ${gateway.allowedGroupMessages}，解析通过 ${incoming.normalized}，解析拒绝 ${incoming.rejected}，新增保存 ${incoming.persisted}。私聊到达 ${gateway.privateMessages} 条（仅连接诊断，不保存、不回复）；恢复连接 ${gateway.reconnects} 次，心跳由 SDK 管理。${gateway.groupMessages===0?'尚未收到群消息推送；在线不等于已收到普通消息。':''}`:'';
      if (!state.error && !state.processingError && /SDK 正在恢复连接/.test($('error').textContent)) $('error').textContent='';
      if(state.error||state.processingError)$('error').textContent=state.error||state.processingError;
      if(!state.config){$('progress').textContent='先配置机器人与指定群。无需 DSH；模型功能需支持隔离调用的候选宿主。';return;}
      const c=state.config;officialConnection=c.provider==='official';$('config-summary').textContent=`${officialConnection?'官方 AppID '+c.appId:'NapCat 机器人 '+c.botQQ} · 群 ${c.groupIds.join('、')} · 原文保留 ${c.retentionDays} 天 · 容量 ${c.maxEvents} · ${c.automation?'宿主隔离模型 / 每日最多 '+c.modelCallsPerDay+' 次':'仅采集，不调用模型'}${officialConnection?' · 撤回通知未验证，不承诺自动同步':''}`;
      $('update-url-label').hidden=officialConnection;clearTokenLabel.hidden=officialConnection;
      $('update-token-label').firstChild.textContent=officialConnection?'新 AppSecret（留空保持不变）':'新访问令牌（留空保持不变）';
      if(!loaded){$('filter-group').replaceChildren(...c.groupIds.map(id=>{const option=el('option',id);option.value=id;return option;}));$('edit-ai').checked=c.automation;$('edit-replies').checked=c.replyEnabled;$('edit-budget').value=c.modelCallsPerDay||'';$('update-url').value=c.qqUrl||'';await feedback(false);await messages(false);loaded=true;}
      if(feedbackCount!==state.progress?.feedback){feedbackCount=state.progress?.feedback;await feedback(false);}
      if(messageCount!==state.messages){messageCount=state.messages;if(messageNext<=20)await messages(false);}
      if(evidenceRevision!==state.progress?.evidenceRevision){evidenceRevision=state.progress?.evidenceRevision;await feedback(false);if(selected){const detail=await call('groupFeedbackDetail',{id:selected.id});if(detail.evidenceChanged){selected=detail;$('feedback-sources').replaceChildren(el('p','原话已撤回或过期，不再展示。'));$('evidence-warning').textContent='来源已变化：当前编辑草稿保留，但不能再作为证据保存；可以调整处理状态。';}}}
      $('jobs').replaceChildren(...(state.progress?.jobs||[]).map(job=>el('li',`${job.groupId} · ${jobNames[job.status]||job.status}${job.error?' · '+job.error:''}`)));
    }catch(error){$('status').textContent='无法读取群状态';$('error').textContent=error.message;if(/身份|作用域/.test(error.message))clearView();}
  }
  function config() { return {...(provider()==='official'?{provider:'official',appId:$('app-id').value.trim(),appSecret:$('secret').value}:{qqUrl:$('url').value.trim(),qqToken:$('token').value,botQQ:$('bot').value.trim()}),groupIds:$('groups').value.split(/[,，\s]+/).filter(Boolean),retentionDays:Number($('retention').value),maxEvents:Number($('capacity').value),automation:$('ai').checked,replyEnabled:$('replies').checked,modelCallsPerDay:Number($('budget').value),collectionNoticeConfirmed:$('consent').checked}; }
  $('official-prepare').onclick=()=>action(async()=>{const input={appId:$('app-id').value.trim(),appSecret:$('secret').value};$('secret').value='';await call('groupOfficialPrepare',input);});
  $('official-stop').onclick=()=>action(()=>call('groupOfficialStop'));
  $('connection').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{const input=config();$('token').value='';$('secret').value='';await call('groupConnect',input);loaded=false;});});
  $('pause').onclick=()=>action(()=>call('groupPause'));
  $('resume').onclick=()=>action(()=>call('groupResume'));
  $('process').onclick=()=>action(()=>call('groupProcess'));
  $('save-ai').onclick=()=>action(async()=>{await call('groupConfigureAI',{automation:$('edit-ai').checked,replyEnabled:$('edit-replies').checked,modelCallsPerDay:Number($('edit-budget').value)});});
  $('update-connection').onclick=()=>action(async()=>{const input=officialConnection?{appSecret:$('update-token').value}:{qqUrl:$('update-url').value};if(!officialConnection){if($('clear-token').checked)input.qqToken='';else if($('update-token').value)input.qqToken=$('update-token').value;}$('update-token').value='';await call('groupUpdateConnection',input);$('clear-token').checked=false;});
  $('clear').onclick=()=>action(async()=>{await call('groupClear',{confirm:$('clear-confirm').value});$('clear-confirm').value='';clearView();$('connection').reset();});
  function filter() { return {groupId:$('filter-group').value,...($('filter-type').value?{type:$('filter-type').value}:{}),...($('filter-status').value?{status:$('filter-status').value}:{})}; }
  async function feedback(more=false) {
    const generation=pageGeneration;
    const result=await call('groupFeedback',{...filter(),after:more?feedbackNext:0});
    if(generation!==pageGeneration)return;
    if(!more)$('feedback-list').replaceChildren();
    for(const item of result.items){const button=el('button',`${item.type==='bug'?'Bug':'建议'} · ${item.title} · ${statuses[item.status]||item.status}${item.evidenceChanged?' · 来源已变化':''}`,'record-button');button.type='button';button.dataset.feedbackId=item.id;button.onclick=()=>action(()=>openFeedback(item.id));$('feedback-list').append(button);}
    if(!result.items.length&&!more)$('feedback-list').append(el('p','暂无匹配反馈。启用模型后自动分批整理；识别质量需人工复核。','hint'));
    feedbackNext=result.next;$('feedback-more').hidden=!result.hasMore;
  }
  async function openFeedback(id) {
    const generation=pageGeneration;const detail=await call('groupFeedbackDetail',{id});if(generation!==pageGeneration)return;
    selected=detail;$('feedback-editor').hidden=false;$('feedback-id').textContent=`${id} · 首次 ${date(detail.firstSeenAt)} · 最近 ${date(detail.lastSeenAt)}`;
    for(const field of ['title','type','status','description','platform','version','reproduction']){$('feedback-'+field).value=detail[field]||'';$('feedback-'+field).disabled=detail.evidenceChanged&&['title','description','platform','version','reproduction'].includes(field);}
    $('feedback-related').value=detail.relatedIds.join(',');$('evidence-warning').textContent=detail.evidenceChanged?'依据已撤回或过期，已移除派生内容，不能继续引用旧原话。':'';
    $('related-suggestions').textContent=detail.suggestedRelated?.length?'相似反馈建议（未自动合并）：'+detail.suggestedRelated.map(item=>`${item.id} · ${item.title}`).join('；'):'';
    $('split-title').value='';$('split-description').value='';$('split-keys').value=detail.sourceIds.join(',');
    $('feedback-sources').replaceChildren(...detail.sources.map(source=>{const article=el('article','', 'source-row');article.append(el('p',`${source.key} · ${source.sender?.nickname||source.sender?.id||'未知发送者'} · ${source.occurredAt?date(source.occurredAt):''}`,'hint'),el('p',source.availability==='available'?source.text:`[${source.availability}]`));return article;}));
  }
  $('feedback-editor').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{if(!selected)return;const patch={id:selected.id,type:$('feedback-type').value,status:$('feedback-status').value,relatedIds:$('feedback-related').value.split(/[,，\s]+/).filter(Boolean)};if(!selected.evidenceChanged)for(const field of ['title','description','platform','version','reproduction'])patch[field]=$('feedback-'+field).value||(['title','description'].includes(field)?'':null);await call('groupFeedbackUpdate',patch);await feedback(false);$('error').textContent='人工修改已保存';});});
  $('feedback-close').onclick=()=>{$('feedback-editor').hidden=true;selected=null;};
  $('feedback-confirm').onclick=()=>action(async()=>{if(!selected)return;await call('groupFeedbackUpdate',{id:selected.id,status:'confirmed'});selected.status='confirmed';$('feedback-status').value='confirmed';await feedback(false);});
  $('split').onclick=()=>action(async()=>{if(!selected)return;const result=await call('groupFeedbackSplit',{id:selected.id,title:$('split-title').value,description:$('split-description').value,sourceIds:$('split-keys').value.split(/[,，\s]+/).filter(Boolean)});await feedback(false);await openFeedback(result.id);});
  async function messages(more=false) {
    const generation=pageGeneration,groupId=$('filter-group').value;const result=await call('groupMessages',{groupId,after:more?messageNext:0});if(generation!==pageGeneration)return;
    if(!more)$('message-list').replaceChildren();
    for(const item of result.messages){const article=el('article','','source-row');article.append(el('p',`${date(item.occurredAt)} · ${item.sender?.nickname||item.sender?.id||'未知发送者'} · 消息 ${item.messageId}`,'hint'),el('p',item.availability==='available'?item.text:`[${item.availability}]`));const button=el('button',item.contentTruncated?'查看完整原文（列表已截断）':'查看消息段','secondary');button.type='button';button.onclick=()=>action(async()=>{let offset=0,content='',chunk;do{chunk=await call('groupMessageDetail',{groupId,messageId:item.messageId,offset});if(!chunk||generation!==pageGeneration)return;content+=chunk.content;offset=chunk.next;}while(chunk.hasMore);$('message-detail').hidden=false;$('message-detail').textContent=JSON.stringify(JSON.parse(content),null,2);});article.append(button);$('message-list').append(article);}
    if(!result.messages.length&&!more)$('message-list').append(el('p','尚无已采集的新消息。','hint'));messageNext=result.next;$('messages-more').hidden=!result.hasMore;
  }
  for(const id of ['filter-group','filter-type','filter-status'])$(id).addEventListener('change',()=>action(async()=>{pageGeneration++;await feedback(false);if(id==='filter-group'){selected=null;$('feedback-editor').hidden=true;$('message-detail').hidden=true;await messages(false);}}));
  $('feedback-more').onclick=()=>action(()=>feedback(true));$('messages-more').onclick=()=>action(()=>messages(true));$('messages-refresh').onclick=()=>action(async()=>{await feedback(false);await messages(false);});$('retry').onclick=()=>action(()=>call('groupRetry',{groupId:$('filter-group').value}));
  void refresh();setInterval(()=>{if(!busy&&!document.getElementById('group-mode').hidden)void refresh();},2000);
})();
