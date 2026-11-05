# QQ 官方机器人接入候选（2026-11-03）

> 下文为首次手写接入的历史记录。2026-11-05 已按用户决定改为腾讯官方 SDK；当前候选与边界见 [SDK 迁移记录](official-sdk-migration.md)。

用户要求配置官方机器人。凭据只交给官方接口和本机宿主加密仓，不进入本文件、源码、构建产物或测试记录。普通 QQ 风控恢复与官方机器人应用的凭据验证是不同步骤；官方路线不等于免风控。

## 范围与接缝

- `official-api.cjs`：固定 HTTPS 官方域名；AppID / AppSecret 换取 Access Token，检查 HTTP 200 中的业务错误码，合并并发刷新；不输出服务端原始错误文本，避免回显敏感内容。
- `official-bot.cjs`：官方网关鉴权、心跳、凭据刷新、授权群事件和带触发消息的被动回复。实际 `/gateway` 仍可能返回 `api.sgroup.qq.com`；仅允许它与 `api.bot.qq.com` 的 WSS，不跟随任意网关域名或 HTTP 跳转。连接失败需手动恢复，不无限重试、盲目重发或承诺补齐离线消息。
- `official-setup.cjs`：作用域隔离的加密凭据准备，异步验证和只记录群标识的发现阶段；不保存发现阶段的聊天正文，不调用模型或发送消息。
- `official-events.cjs`：归一化群消息、引用与非文本元数据，剔除场景鉴权令牌。群数据按 `official-AppID + group_openid + message.id` 隔离，不把官方 OpenID 当数字 QQ 号。
- 群采集、反馈、隔离 AI 与桌宠查询继续沿用原模块；旧 NapCat / DSH 私聊不改变协议。没有修改宿主 SDK、类型包、脚手架或市场登记，也没有发布。

## 验证边界

- 具名专项入口：`npm run test:official`，已纳入 `npm test`。覆盖 HTTP 200 业务失败、密钥不回显、并发凭据刷新、网关范围、群白名单、@ 与自消息、引用／附件、去重、时效、未知发送结果不重发、准备阶段不保存正文及作用域隔离。
- 受影响回归：`npm run test:group:e2e`、`npm run test:e2e`，使用配套宿主和独立隐藏 profile，覆盖真实面板、utilityProcess、加密持久化、反馈／桌宠查询及旧私聊模式。界面切换通过真实键盘输入。
- 真实官方接口：凭据请求成功，获取网关成功，独立进程收到 READY 并观察 15 秒仍在线；尚不能代表长期运行成功。
- 真实试点 profile：`turitopia-qq-feedback-pilot`，与日常 profile 隔离；安装通过宿主安装／授权入口。密钥文件为 `enc:` 值，面板不回读 AppSecret。
- 首次应用连接曾被网关要求重新鉴权，具体原因尚未确认。后续重新启动独立试点、手动验证后，面板已恢复在线，并持续观察到超过一轮网关心跳的时间。新增禁止连接中／在线状态重复验证的保护，不把这一防护推断为已定位首次失败的根因；长期运行仍未验收。
- 本批最终 `npm test` 为 28/28，通过的隐藏应用证据位于本地忽略目录 `artifacts/group-1793674453673` 与 `artifacts/electron-1793674088294`；前者覆盖最后一次群存储修改，后者覆盖旧 DSH 邻接回归。新增重复验证保护另经专项断言验证。
- 交付检查时，安装目录的官方接入、群存储与面板文件均与候选源码一致，已有凭据记录均为密文；随后检测到试点应用退出，当前不能表述为仍在线。重启后需点击“验证密钥并发现测试群”，留空复用已保存密钥。
- 真实群 OpenID、群主全量授权、普通消息／@ 实际收发和真实模型质量尚待操作者验收。官方普通群成员撤回通知仍是未确认项。

## 操作顺序

先完成仅验证／发现，再由操作者选定群、明确保留期限和容量并确认采集告知；最后才启用采集及可选模型。密钥曾在聊天中提供的，建议在官方后台重置，并在本机更新；不要继续通过聊天传递新密钥。

## 2026-11-03 群记录不可见排查增量

- 已自动复现 `GroupStore.query` 只接受数字群号，官方 OpenID 被拒为 `invalid-group-query`。修复为接受有长度限制的 opaque 标识；服务层仍要求群白名单精确匹配，不扩大可读群范围。
- 修复面板初始化在查询失败后仍被标为“已加载”的问题；失败后可以重试，不永久留下空列表。
- 为每次连接增加网关消息／全量／@／授权匹配数、解析通过／拒绝／保存／重复数与心跳确认数。只暴露计数、事件类型、字段类型和校验结果，不存聊天正文、消息 ID、发送者、未授权群标识或鉴权令牌。
- `npm test` 为 28/28；`npm run test:official:e2e`（新增并纳入群交付门禁）使用真实隐藏 Electron 与本地官方 HTTP/WS 夹具，验证全量／@ 入库、OpenID 查询、真实面板显示、去重、拒绝非法时间、外群隔离和重启持久化。证据在忽略目录 `artifacts/official-e2e-1793675677276`。旧群反馈真实应用回归通过，证据在 `artifacts/group-1793675609292`。
- 已通过正常宿主安装入口更新实际试点；更新前后比较配置一致，保留已选群、4 天、5000 条、每日 100 次模型预算及关闭群回复的选择。更新后恢复采集，真实 OpenID 查询已可返回，不再报格式错误。
- 本次更新后的初次实测只收到官方网关 READY，群消息计数为零。这不足以判断用户此前消息为何未记录；需在新连接上发送一条普通消息及一条真正的 @，按新增计数区分未推送、群匹配失败和解析拒绝。未收过的离线消息不承诺补齐。

## 一手依据

- [访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)
- [WebSocket](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html)
- [全量群消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)
- [群 @ 消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html)
- [群回复](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)
- [权限及主体限制](https://bot.q.qq.com/wiki/bot_FAQ/)
