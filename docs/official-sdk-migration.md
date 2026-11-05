# 腾讯官方 SDK 接入候选（2026-11-05）

> `0.3.0-dev.3` 按用户后续要求增加本人单轮私聊回复入口；下文“私聊仅诊断”仍适用于群采集／发现模式。新私聊入口的白名单、预算与验证边界见 [本人私聊测试](official-private-trial.md)。

## 用户决定与范围

用户确认 Harness 的成功测试是私聊，并同意复用腾讯官方 SDK。插件升级为 `0.3.0-dev.2`，固定依赖 `@tencent-connect/qqbot-nodejs@1.0.5`，与本机 `@tencent-connect/dsh-qqbot@0.5.5` 使用的版本一致。采用官方公开的 `/protocol` 入口，通过动态 import 兼容现有 CJS 插件，不复制其底层协议源码。

本轮只替换 QQ 协议接入，不迁移到 Harness 运行、不共享 Harness 历史、不增加文件或终端工具权限。现有群白名单、加密存储、原文保留期、模型预算、反馈整理、桌宠查询和 NapCat / DSH 历史模式保留。

私聊增加**仅收件诊断**：统计当前连接收到的 C2C 消息数量和最近到达时间；不保存正文、发送者或消息 ID，不调用模型，不回复私聊，不混入群上下文。这不是“主人私聊与桌宠记忆接续”功能。

## 改动地图

- `official-api.cjs`：凭据校验与错误脱敏包装；访问凭证、刷新、HTTP 请求交给 SDK 的 `TokenManager` / `ApiClient`。与 Harness 一样把 API 和 token 域名明确设置为 `api.bot.qq.com`，不依赖 SDK 的旧域名默认值。SDK logger 不接入，避免 debug 原始正文／凭据输出。
- `official-bot.cjs`：SDK `GatewayConnection` 负责 WS 握手、心跳、解码、断线重连及进程内 RESUME。只请求群／私聊相关 intents，连续恢复失败预算为 3 次；初次启动 12 秒超时。应用退出或暂停会中止 SDK 与 token 刷新。
- `group-collector.cjs`：SDK 恢复期间标明 `reconnecting` 与离线区间，恢复后继续采集，不把恢复能力表述为完整历史补齐。
- `official-setup.cjs`、`panel/group.js`：展示 SDK 版本、私聊到达计数和恢复次数；心跳明确由 SDK 管理，不伪造 ACK 统计。
- `scripts/package-local.cjs`：本地安装目录包含 SDK 和它的 `ws` 运行依赖、许可证；不包含账号、凭据或测试产物。

发送使用 SDK 的单请求 `ApiClient.request`，不启用发送重试包装或“被动失败转主动推送”。原群、触发消息、五分钟时效、固定回复序号、发送尝试账本与原有持久化任务状态继续限制投递；未知结果不盲目重发。

## 验证

- `npm test`：29 项通过，含 SDK token singleflight、过期刷新、业务错误脱敏、C2C 只计数、群过滤、SDK 回调恢复、取消启动与分发目录依赖检查。
- `test:official:e2e`：真实隐藏 Electron / utilityProcess / 加密存储 / 面板，**使用真实腾讯 SDK 协议类**，只有 QQ HTTP/WS 与账号服务替换成本地夹具。验证普通群消息／@ 保存与 OpenID 查询、私聊计数但无正文入库、真实 opcode 6 RESUME、重放去重、恢复等待期间暂停取消网络，以及进程重启持久化。证据：`artifacts/official-e2e-1793854397695`。
- 相邻回归 `test:group:e2e`、`test:e2e` 通过，证据分别为 `artifacts/group-1793854395300`、`artifacts/electron-1793854396414`。
- 合成协议和真实应用测试不代表真实 QQ 私聊／群聊收件已验收；真实对照必须保证 Harness 与本插件没有同时占用同一机器人，再分别验证 C2C、群 @、普通群消息。普通群全量接收仍受群主实际授权控制。

## 实机验证补充（2026-11-06）

- 用户确认官方私聊路径成功，运行状态可核对两条本人消息均完成回复。
- 用户随后在一个仅有本人和机器人的两人群中手动发出真实 @。SDK 群事件已匹配授权群、解析通过并保存一条原文；对应聊天任务为 `completed`，用户确认群测试成功。
- 本次群验证使用独立的官方群 OpenID 白名单，而非把数字 QQ 群号直接当 OpenID。私聊配置保留但暂停，避免双连接。
- 当时运行诊断的全量群事件计数仍为 0，因此只确认真实群 @ 链路，不把用户的成功反馈扩张成普通全量采集、撤回或长期运行均已验收。官方 `recv_msg_setting` 曾返回空字符串，不能仅凭该空值断言接收权限关闭。
- 源码、测试和文档可推送；账号资料、私聊／群正文、应用密钥、实例配置及本机诊断不进入仓库。此处不记录实际群号、OpenID 或个人身份。

## 一手来源

- 腾讯 SDK npm 固定版本：<https://www.npmjs.com/package/@tencent-connect/qqbot-nodejs/v/1.0.5>
- SDK 公开入口与使用指南：<https://github.com/tencent-connect/qqbot-nodejs>
- Harness 官方 QQ 插件：<https://github.com/tencent-connect/dsh-qqbot>
- 本机安装包同时携带 README、USAGE、类型声明与协议源码，已按实际安装的 1.0.5 / 0.5.5 对账；没有根据未发布的主分支能力实现。
