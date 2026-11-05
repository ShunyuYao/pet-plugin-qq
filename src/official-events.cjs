'use strict';
const { openId } = require('./official-bot.cjs');
// Persist only message data. message_scene.auth_token and transport credentials
// are deliberately excluded, including from nested forwarded messages.
function contentSegments(data, depth = 0) {
  if (depth > 5) return [{ type: 'unparsed', data: { reason: 'nested-message-depth-limit' } }];
  const parts = [];
  if (typeof data.content === 'string') parts.push({ type: 'text', data: { text: data.content } });
  for (const item of (Array.isArray(data.attachments) ? data.attachments : []).slice(0, 100)) {
    const meta = {};
    for (const key of ['url','filename','width','height','size','content_type']) if (['string','number'].includes(typeof item?.[key])) meta[key] = item[key];
    parts.push({ type: 'attachment', data: meta });
  }
  if (data.ark_data && typeof data.ark_data === 'object') {
    const card = { ark_type: data.ark_data.ark_type, ark_name: data.ark_data.ark_name, prompt: data.ark_data.prompt, fields: {} };
    for (const key of ['title','desc','jump_url','preview','source','nickname','address']) if (typeof data.ark_data.fields?.[key] === 'string') card.fields[key] = data.ark_data.fields[key];
    parts.push({ type: 'card', data: card });
  }
  for (const child of (Array.isArray(data.msg_elements) ? data.msg_elements : []).slice(0, 100)) {
    parts.push({ type: 'nested_message', data: { messageType: child.message_type, segments: contentSegments(child, depth + 1) } });
  }
  if (!parts.length) parts.push({ type: 'unparsed', data: { messageType: data.message_type ?? null } });
  return parts;
}
function normalizeOfficialEvent(raw, config, receivedAt = Date.now()) {
  if (!raw || raw.op !== 0 || !['GROUP_MESSAGE_CREATE','GROUP_AT_MESSAGE_CREATE'].includes(raw.t)) return null;
  const data = raw.d;
  if (!data || !openId(data.group_openid) || !config.groupIds.includes(data.group_openid)) return null;
  if (typeof data.id !== 'string' || !/^[A-Za-z0-9_.=+/-]{1,512}$/.test(data.id)) return null;
  const occurredAt = Date.parse(data.timestamp);
  if (!Number.isFinite(occurredAt)) return null;
  if (Buffer.byteLength(JSON.stringify(raw)) > 256 * 1024) throw Error('官方群事件过大，已停止采集。');
  const groupId = data.group_openid, messageId = data.id;
  const author = data.author || {}, authorId = author.member_openid || author.id;
  const self = author.bot === true || (typeof raw.botIdentity === 'string' && authorId === raw.botIdentity);
  const segments = contentSegments(data);
  const mentions = (Array.isArray(data.mentions) ? data.mentions : []).filter(item => typeof item?.id === 'string' || typeof item?.member_openid === 'string');
  const mentioned = !self && (raw.t === 'GROUP_AT_MESSAGE_CREATE' || mentions.some(item => [item.id,item.member_openid].includes(raw.botIdentity)));
  for (const item of mentions) segments.push({ type: 'at', data: { id: item.member_openid || item.id, bot: item.bot === true } });
  const ext = Array.isArray(data.message_scene?.ext) ? data.message_scene.ext : [];
  const reference = ext.filter(item => typeof item === 'string' && item.startsWith('ref_msg_idx=')).map(item => item.slice(12));
  for (const id of reference) segments.push({ type: 'reply', data: { id } });
  const textOf = items => items.map(item => item.type === 'text' ? item.data.text : item.type === 'nested_message' ? '[嵌套消息]' + textOf(item.data.segments) : '[' + item.type + ']').join('');
  return { key: [config.botQQ,groupId,messageId].join(':'), kind: 'message', botId: config.botQQ, groupId, messageId,
    occurredAt, receivedAt, segments, text: textOf(segments), self, mentioned, replyTo: reference,
    subtype: raw.t, sender: { id: typeof authorId === 'string' ? authorId : null, nickname: typeof author.username === 'string' ? author.username : null, card: null }, anonymous: null };
}
module.exports = { normalizeOfficialEvent, contentSegments };
