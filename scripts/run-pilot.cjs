'use strict';
// User-invoked visible pilot, separate from daily app and automated profiles.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const host=path.resolve(process.env.PET_PLUGIN_HOST_DIR||path.join(__dirname,'../../desktop-pet-qq-feedback-host/demo'));
const tasks=path.join(host,'core/plugin-runtime/ai-tasks.js');
if(!fs.existsSync(tasks)||!fs.readFileSync(tasks,'utf8').includes('isolated-ai-tools-forbidden'))throw Error('需要本轮支持隔离模型调用的宿主源码。设置 PET_PLUGIN_HOST_DIR 指向其 demo 目录；旧安装包不等于兼容。');
const profile=path.join(os.homedir(),process.platform==='darwin'?'Library/Application Support':'.local/share','turitopia-qq-feedback-pilot');
fs.mkdirSync(profile,{recursive:true});
const binary=require(path.join(host,'node_modules/electron'));
console.log('试点独立数据目录：'+profile+'\n首次启动后按应用正常登录并配置模型，再从插件中心手动安装本插件目录。不会修改日常 profile，不自动授予权限或登录 QQ。');
const env={...process.env,PET_USERDATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(binary,['.'],{cwd:host,env,stdio:'inherit'});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code||0;});
process.on('SIGINT',()=>child.kill('SIGTERM'));process.on('SIGTERM',()=>child.kill('SIGTERM'));
