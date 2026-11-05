'use strict';
const {createHash}=require('node:crypto');
const {OfficialBot,openId}=require('./official-bot.cjs');
const {credentials}=require('./official-api.cjs');
const {isolatedModel,delay}=require('./group-worker.cjs');
const hash=value=>createHash('sha256').update(value).digest('hex');
const issue=code=>Object.assign(Error(code),{privateIssue:code});
function validEnvelope(saved,scope){return saved?.version===1&&saved.scopeId===scope.scopeId&&Array.isArray(saved.ledger)&&saved.ledger.length<=2000
  &&saved.ledger.every(row=>row&&/^[a-f0-9]{64}$/.test(row.key)&&Number.isFinite(row.at)&&['queued','running','sending','completed','unknown','failed'].includes(row.status))
  &&new Set(saved.ledger.map(row=>row.key)).size===saved.ledger.length&&saved.calls&&typeof saved.calls==='object'&&!Array.isArray(saved.calls)
  &&Object.entries(saved.calls).every(([day,count])=>/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isInteger(count)&&count>=0&&count<=500);}
function validatePrivateConfig(input){
  const c=credentials(input),ownerOpenId=String(input?.ownerOpenId||'').trim();
  if(!openId(ownerOpenId)||/^\d{1,15}$/.test(ownerOpenId))throw Error('请绑定本人 user_openid，不能填普通 QQ 号。');
  if(!Number.isInteger(input.modelCallsPerDay)||input.modelCallsPerDay<1||input.modelCallsPerDay>500)throw Error('请设置每日模型调用上限（1–500）。');
  if(input.confirmed!==true)throw Error('请确认只开放本人私聊及模型服务使用。');
  return {...c,ownerOpenId,modelCallsPerDay:input.modelCallsPerDay,confirmed:true};
}
class OfficialPrivate {
  constructor(pet,{authorize,canOpen,makeBot=c=>new OfficialBot(c),runModel,now=Date.now,minGap=6500}={}){
    Object.assign(this,{pet,authorize,canOpen,makeBot,now,minGap});this.lastCall=0;this.runModel=runModel||((text,signal)=>isolatedModel(pet,text,signal));
    this.epoch=0;this.scope=null;this.envelope=null;this.bot=null;this.state='idle';this.error='';this.disposed=false;
    this.writes=Promise.resolve();this.tasks=Promise.resolve();this.pending=0;
    this.api={directState:async caller=>{await authorize(caller);return this.status();},
      directConnect:async(input,caller)=>{await authorize(caller);return this.connect(input);},
      directUpdate:async(input,caller)=>{await authorize(caller);return this.update(input);},
      directPause:async caller=>{await authorize(caller);return this.pause();},
      directResume:async caller=>{await authorize(caller);return this.resume();}};
  }
  active(){return ['connecting','connected','reconnecting'].includes(this.state);}
  key(scope=this.scope){return 'official.private.v1.'+hash(scope.scopeId);}
  async guard(epoch=this.epoch,scope=this.scope,connected=false){
    if(this.disposed||epoch!==this.epoch||!scope)throw Error('私聊身份或连接已改变。');
    const actual=await this.pet.profile.getScope();
    if(epoch!==this.epoch||actual.scopeId!==scope.scopeId||actual.revision!==scope.revision)throw Error('私聊身份或连接已改变。');
    if(connected&&(this.state!=='connected'||!this.bot?.ready))throw Error('私聊已暂停或断线。');
  }
  tx(change,epoch=this.epoch){
    const scope=this.scope;
    const result=this.writes.then(async()=>{
      await this.guard(epoch,scope);if(!this.envelope)throw Error('尚未配置官方私聊。');
      const next=structuredClone(this.envelope);const value=change(next);
      await this.guard(epoch,scope);await this.pet.secrets.set(this.key(scope),next);
      if(this.scope===scope)this.envelope=next;
      await this.guard(epoch,scope);return value;
    });this.writes=result.catch(()=>{});return result;
  }
  stop(){++this.epoch;this.controller?.abort();this.bot?.close();this.bot=null;this.state=this.envelope?'paused':'idle';}
  async restore(){
    this.stop();this.envelope=null;this.scope=await this.pet.profile.getScope();const epoch=this.epoch;
    const saved=await this.pet.secrets.get(this.key());await this.guard(epoch);
    if(!saved){this.state='idle';return;}
    if(!validEnvelope(saved,this.scope))throw Error('私聊数据格式无效，未覆盖原数据。');
    validatePrivateConfig(saved.config);this.envelope=saved;this.state='paused';
    if(saved.enabled){try{await this.open();}catch(e){this.state='offline';this.error=e.message;}}
  }
  async connect(input,expectedScope){
    if(this.active())throw Error('请先暂停官方私聊。');
    await this.canOpen();const config=validatePrivateConfig(input);
    this.stop();this.scope=await this.pet.profile.getScope();const epoch=this.epoch;
    if(expectedScope&&(this.scope.scopeId!==expectedScope.scopeId||this.scope.revision!==expectedScope.revision))throw Error('宠物身份已改变，未绑定私聊。');
    const old=await this.pet.secrets.get(this.key());await this.guard(epoch);
    if(old&&!validEnvelope(old,this.scope))throw Error('私聊数据格式无效，未覆盖原数据。');
    if(old&&(old.config?.appId!==config.appId||old.config?.ownerOpenId!==config.ownerOpenId))throw Error('已有其他机器人或主人的私聊账本，不能覆盖。');
    this.envelope=old||{version:1,scopeId:this.scope.scopeId,config,enabled:false,ledger:[],calls:{}};
    await this.tx(data=>{data.config=config;data.enabled=true;});await this.open();return {connected:true};
  }
  async open(){
    await this.canOpen();await this.guard();this.stop();const epoch=this.epoch;
    await this.tx(data=>{for(const row of data.ledger)if(['queued','running','sending'].includes(row.status))row.status='unknown';});
    const config=this.envelope.config;
    this.state='connecting';this.error='';this.controller=new AbortController();
    const bot=this.bot=this.makeBot({...config,groupIds:[],privateOwnerOpenId:config.ownerOpenId});
    bot.on('private-event',event=>this.enqueue(event,epoch));
    bot.on('reconnecting',()=>{if(epoch===this.epoch)this.state='reconnecting';});
    bot.on('reconnected',()=>{if(epoch===this.epoch){this.state='connected';this.error='';}});
    bot.on('offline',()=>{if(epoch===this.epoch){this.stop();this.state='offline';this.error='私聊连接已停止，请核对后重连。';}});
    try{await bot.open();await this.guard(epoch);this.state='connected';}
    catch(error){if(epoch===this.epoch){this.stop();this.state='offline';this.error=error.message;}throw error;}
  }
  async pause(){this.stop();if(this.envelope)await this.tx(data=>{data.enabled=false;});this.error='';return true;}
  async update(input){
    if(this.active()||!this.envelope)throw Error('请先暂停已配置的官方私聊。');
    const config=validatePrivateConfig({...this.envelope.config,...(input?.appSecret?{appSecret:input.appSecret}:{}),...(input?.modelCallsPerDay===undefined?{}:{modelCallsPerDay:input.modelCallsPerDay})});
    await this.tx(data=>{data.config=config;});this.error='';return true;
  }
  async resume(){if(!this.envelope)throw Error('尚未配置官方私聊。');if(this.active())throw Error('私聊正在连接或已在线。');await this.canOpen();await this.tx(data=>{data.enabled=true;});await this.open();return true;}
  enqueue(event,epoch){
    if(epoch!==this.epoch||!['connected','connecting'].includes(this.state)||event.senderId!==this.envelope?.config.ownerOpenId)return;
    if(this.pending>=20){this.stop();this.state='offline';this.error='私聊队列已满，已停止连接。';return;}
    if(typeof event.text!=='string'||!event.text.trim()||event.text.length>8000||typeof event.messageId!=='string'||event.messageId.length>512||!Number.isFinite(event.occurredAt)){
      this.error='首版私聊测试仅支持有效的文字消息（最多8000字）。';return;
    }
    this.pending++;const signal=this.controller.signal;
    this.tasks=this.tasks.then(()=>this.process(event,epoch,signal)).catch(()=>{}).finally(()=>this.pending--);
  }
  async process(event,epoch,signal){
    const key=hash(event.messageId);let phase='queued';
    try{
      await this.guard(epoch,this.scope,true);signal.throwIfAborted();
      if(this.now()-event.occurredAt>=300000||event.occurredAt>this.now()+60000)throw issue('expired');
      const accepted=await this.tx(data=>{
        if(data.ledger.some(row=>row.key===key))return false;
        if(data.ledger.length>=2000)throw issue('capacity');
        data.ledger.push({key,at:this.now(),status:'queued'});return true;
      },epoch);if(!accepted)return;
      await this.tx(data=>{
        const day=new Date(this.now()).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
        if((data.calls[day]||0)>=data.config.modelCallsPerDay)throw issue('budget');
        data.calls={[day]:(data.calls[day]||0)+1};data.ledger.find(row=>row.key===key).status='running';
      },epoch);phase='running';
      const gap=this.minGap-(this.now()-this.lastCall);if(gap>0)await delay(gap,signal);
      await this.guard(epoch,this.scope,true);signal.throwIfAborted();this.lastCall=this.now();
      // Deliberately single-turn. The SDK call supplies no private history,
      // group context or tools; raw message text is never persisted here.
      const reply=(await this.runModel(event.text,signal)).trim().slice(0,1000);
      await this.guard(epoch,this.scope,true);signal.throwIfAborted();
      await this.tx(data=>{data.ledger.find(row=>row.key===key).status='sending';},epoch);phase='sending';
      await this.guard(epoch,this.scope,true);signal.throwIfAborted();
      await this.bot.sendPrivate(this.envelope.config.ownerOpenId,reply,event);
      await this.tx(data=>{data.ledger.find(row=>row.key===key).status='completed';},epoch);this.error='';
    }catch(error){
      if(epoch!==this.epoch)return;
      this.error=({budget:'今日私聊模型预算已用完。',capacity:'私聊去重账本已满，请暂停并联系维护者。',expired:'私聊消息已过期。'})[error.privateIssue]||'私聊处理未确认，请核对状态；不会自动重发。';
      try{await this.tx(data=>{const row=data.ledger.find(row=>row.key===key);if(row)row.status=phase==='sending'?'unknown':'failed';},epoch);}
      catch{this.stop();this.state='offline';this.error='私聊账本写入未确认，已停止连接。';}
    }
  }
  async status(){
    if(this.scope)await this.guard();
    const data=this.envelope,day=new Date(this.now()).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
    return {state:this.state,error:this.error,pending:this.pending,configured:!!data,appId:data?.config.appId||'',ownerLabel:data?'已绑定本人 …'+data.config.ownerOpenId.slice(-6):'',modelCallsPerDay:data?.config.modelCallsPerDay||0,calls:data?.calls[day]||0,
      received:data?.ledger.length||0,completed:data?.ledger.filter(r=>r.status==='completed').length||0,jobs:data?.ledger.slice(-8).map(r=>({at:r.at,status:r.status}))||[],diagnostics:this.bot?.diagnostics?.()||null};
  }
  contextChanged(){this.stop();return this.restore();}
  dispose(){this.disposed=true;this.stop();}
}
module.exports={OfficialPrivate,validatePrivateConfig};
