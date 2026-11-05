'use strict';
const { loopback } = require('./dsh.cjs');
const { createHash } = require('node:crypto');
const MAX_EVENT_BYTES = 256 * 1024;
function id(value, positive = false) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  if (!['number', 'string'].includes(typeof value)) return null;
  const text = String(value);
  return (positive ? /^[1-9]\d{0,15}$/ : /^-?\d{1,20}$/).test(text) ? text : null;
}
function validateGroupConfig(input) {
  if (input?.provider !== undefined && !['official','onebot'].includes(input.provider)) throw Error('未知 QQ 接入方式');
  const official = input?.provider === 'official';
  let connection;
  if (official) {
    const { credentials } = require('./official-api.cjs');
    const { openId } = require('./official-bot.cjs');
    const { appId, appSecret } = credentials(input);
    if (!Array.isArray(input.groupIds) || !input.groupIds.length || input.groupIds.length > 20 || input.groupIds.some(value => !openId(value)) || new Set(input.groupIds).size !== input.groupIds.length) throw Error('请选择 1–20 个官方 group_openid（不是数字群号）。');
    connection = { provider: 'official', appId, appSecret, botQQ: 'official-' + appId, groupIds: [...input.groupIds] };
  } else {
    const qqUrl = String(input?.qqUrl || '').trim(), qqToken = String(input?.qqToken || '').trim();
    loopback(qqUrl, ['ws:', 'wss:']);
    const botQQ = id(input?.botQQ, true);
    if (!botQQ || !Array.isArray(input.groupIds) || !input.groupIds.length || input.groupIds.length > 20) throw Error('请选择 1–20 个指定群和机器人账号。');
    const groupIds = input.groupIds.map(value => id(value, true));
    if (groupIds.some(value => !value || !Number.isSafeInteger(Number(value))) || !Number.isSafeInteger(Number(botQQ)) || new Set(groupIds).size !== groupIds.length) throw Error('群号无效或重复。');
    if (qqToken.length > 4096 || /[\r\n]/.test(qqToken)) throw Error('访问令牌格式无效。');
    connection = { qqUrl, qqToken, botQQ, groupIds };
  }
  if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 365) throw Error('请明确原文保留天数（1–365）。');
  if (!Number.isInteger(input.maxEvents) || input.maxEvents < 1 || input.maxEvents > 50000) throw Error('请明确事件容量（1–50000）；满额停止，不静默删记录。');
  if (input.collectionNoticeConfirmed !== true) throw Error('请先在试点群说明采集用途、访问对象及保留期限。');
  if (input.automation === true && (!Number.isInteger(input.modelCallsPerDay) || input.modelCallsPerDay < 1 || input.modelCallsPerDay > 500)) throw Error('请明确每日模型调用次数预算（1–500）');
  return { ...connection, retentionDays: input.retentionDays, maxEvents: input.maxEvents, collectionNoticeConfirmed: true, automation: input.automation === true, replyEnabled: input.replyEnabled === true, modelCallsPerDay: input.automation === true ? input.modelCallsPerDay : 0 };
}
function messageKey(botId, groupId, messageId) { return [botId, groupId, messageId].join(':'); }
function normalizeGroupEvent(raw, config, receivedAt = Date.now()) {
  if (!raw || typeof raw !== 'object' || id(raw.self_id, true) !== config.botQQ) return null;
  if(raw.post_type==='notice' && raw.notice_type==='group_upload'){
    const groupId=id(raw.group_id,true),file=raw.file;
    if(!groupId || !config.groupIds.includes(groupId) || !Number.isSafeInteger(raw.time) || raw.time<0 || !file || !['string','number'].includes(typeof file.id))return null;
    if(Buffer.byteLength(JSON.stringify(raw))>MAX_EVENT_BYTES)throw Error('群文件事件过大，已停止采集');
    const messageId='upload_'+createHash('sha256').update(JSON.stringify([file.id,raw.user_id,raw.time])).digest('hex').slice(0,20);
    const data={id:String(file.id),name:typeof file.name==='string'?file.name:null,size:Number.isFinite(file.size)?file.size:null};
    return {key:messageKey(config.botQQ,groupId,messageId),kind:'message',botId:config.botQQ,groupId,messageId,occurredAt:raw.time*1000,receivedAt,subtype:'file_notice',segments:[{type:'file',data}],text:'[file:'+String(data.name||'未知文件')+']',sender:{id:id(raw.user_id,true),nickname:null,card:null},anonymous:null,self:id(raw.user_id,true)===config.botQQ,mentioned:false,replyTo:[]};
  }
  const groupId = id(raw.group_id, true), messageId = id(raw.message_id);
  if (!groupId || !config.groupIds.includes(groupId) || !messageId || !Number.isSafeInteger(raw.time) || raw.time < 0) return null;
  const key = messageKey(config.botQQ, groupId, messageId);
  const base = { key, botId: config.botQQ, groupId, messageId, occurredAt: raw.time * 1000, receivedAt };
  if (raw.post_type === 'notice' && raw.notice_type === 'group_recall') return { ...base, kind: 'recall', operatorId: id(raw.operator_id, true) };
  if (!['message', 'message_sent'].includes(raw.post_type) || raw.message_type !== 'group') return null;
  const self = id(raw.user_id, true) === config.botQQ;
  if (raw.post_type === 'message_sent' && !self) return null;
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_EVENT_BYTES) throw Error('群事件过大，已停止采集，请核对缺失记录。');
  const segments = Array.isArray(raw.message) ? structuredClone(raw.message) : [{ type: 'unparsed', data: { raw: typeof raw.message === 'string' ? raw.message : null } }];
  const text = segments.map(p => {
    if (p?.type === 'text' && typeof p.data?.text === 'string') return p.data.text;
    if (p?.type === 'at') return '@' + (p.data?.qq ?? '未知');
    if (p?.type === 'reply') return '[引用:' + (p.data?.id ?? '未知') + ']';
    return '[' + (typeof p?.type === 'string' ? p.type : 'unknown') + ']';
  }).join('');
  const anonymous = raw.sub_type === 'anonymous';
  const stringOrNull = v => typeof v === 'string' ? v : null;
  return { ...base, kind: 'message', segments, text, self,
    subtype: stringOrNull(raw.sub_type),
    mentioned: !self && segments.some(p => p?.type === 'at' && String(p.data?.qq) === config.botQQ),
    replyTo: [...new Set(segments.filter(p => p?.type === 'reply').map(p => id(p.data?.id)).filter(v => v !== null))],
    sender: { id: anonymous ? null : id(raw.user_id, true), nickname: anonymous ? null : stringOrNull(raw.sender?.nickname), card: anonymous ? null : stringOrNull(raw.sender?.card) },
    anonymous: anonymous ? { id: id(raw.anonymous?.id), name: stringOrNull(raw.anonymous?.name) } : null,
  };
}
module.exports = { id, messageKey, validateGroupConfig, normalizeGroupEvent };
