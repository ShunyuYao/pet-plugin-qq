'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const script=fs.readFileSync(path.join(__dirname,'../panel/shell.js'),'utf8');
function setup(pet){
  let click;
  const button={disabled:false,addEventListener:(event,fn)=>{assert.equal(event,'click');click=fn;}};
  const error={hidden:true,textContent:''};
  vm.runInNewContext(script,{window:{pet},document:{getElementById:id=>id==='panel-close'?button:error}});
  return {button,error,click:()=>click()};
}
test('close uses only the panel API and guards duplicate requests',async()=>{
  let finish,calls=0;
  const ui=setup({ui:{closePanel:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}}});
  const pending=ui.click();assert.equal(ui.button.disabled,true);
  await ui.click();assert.equal(calls,1);
  finish(true);await pending;assert.equal(ui.error.hidden,true);assert.equal(ui.button.disabled,false);
});
for(const kind of ['false','reject','missing'])test('failed close can be retried: '+kind,async()=>{
  let calls=0;
  const ui=setup(kind==='missing'?{}:{ui:{closePanel:async()=>{calls++;if(kind==='reject')throw Error('private details');return false;}}});
  await ui.click();assert.equal(ui.error.hidden,false);assert.match(ui.error.textContent,/关闭失败/);assert.equal(ui.button.disabled,false);
  await ui.click();assert.equal(calls,kind==='missing'?0:2);
});
