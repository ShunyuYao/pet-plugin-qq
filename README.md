# 吐梨邦 · QQ 宠物连接插件

`pet-plugin-qq` 是 **吐梨邦桌宠的 QQ 连接插件**，安装在吐梨邦中运行，让 QQ 与吐梨邦桌面宠物成为同一只宠物的两个聊天入口，共用上下文。使用本插件需要配合支持相应接口的吐梨邦版本。

产品规划包含“让当前桌宠接入 QQ”和“连接已有 QQ 宠物”两种必备模式，B 站生活联动为可选扩展，不是安装或使用前提。

<!-- turitopia:context:start -->
## 关于吐梨邦

**吐梨邦（Turi Topia）是一款 AI 桌宠产品：陪你聊天、互动，还能到朋友的桌面串门，并通过插件扩展能力。**

官网：[turitopia.com](https://turitopia.com/)

## 插件生态

| 公开仓库 | 用途 |
| --- | --- |
| [create-pet-plugin](https://github.com/ShunyuYao/create-pet-plugin) | 插件脚手架与开发指南，从这里创建插件项目。 |
| [pet-plugin-types](https://github.com/ShunyuYao/pet-plugin-types) | 插件 SDK 类型与 API 契约，查询可用能力和接口。 |
| [pet-plugin-registry](https://github.com/ShunyuYao/pet-plugin-registry) | 插件市场登记表、提交方式与审核规则。 |
<!-- turitopia:context:end -->

## 市场上线状态

| 项目 | 当前情况 |
| --- | --- |
| 上架状态 | **未上架**，目前不能从吐梨邦插件市场安装 |
| 市场版本 | 无；源码版本为 0.1.0 测试版，尚无插件 Release |
| 最近核实 | 2026-11-02 |
| 核实依据 | [正式登记清单固定快照](https://github.com/ShunyuYao/pet-plugin-registry/blob/b537846bdbe7a7e8dcdfc26b8e709f8552eb11dd/registry/plugins.json)中没有插件 ID `qq-context`；[Release 列表](https://github.com/ShunyuYao/pet-plugin-qq/releases)为空 |
| 应用内验证 | 尚未验证市场可见与市场下载安装；已有本地插件加载、真实 Electron 和 DSH 测试不等于市场上线验证 |

以上是核实日期时的状态。市场发布后需更新本节；当前测试源码的安装方式见下文。

## 两种模式与开发优先级

用户于 **2026-11-02** 确认：**两种模式都必须做，优先做模式一。** 完整决策、配置门槛、调研依据及后续验收见 [产品模式与优先级](docs/product-modes.md)。

| 模式 | 用户目标 | 是否需要另外安装 DSH | 当前状态 |
| --- | --- | --- | --- |
| **模式一 · 首要必做：让当前桌宠接入 QQ** | 沿用桌宠已有的模型配置、人设和记忆，在 QQ 继续聊天 | **不需要**；目标是复用桌宠内的会话能力，另行配置 QQ 接入 | 待实现，下一阶段优先 |
| **模式二 · 同样必做：连接已有 QQ 宠物** | 将原 QQ 宠物接到桌面，保留其历史、人设和记忆 | 取决于原后端；DSH 用户复用原服务，其他后端需要相应适配 | 已实现 DSH + NapCat 的测试源码版；其他后端未适配 |

**下面的安装步骤和测试结果仅针对当前模式二的 DSH 适配。** 当前版本要求已有、正在运行的 DSH，并不包含自动安装 DSH 的功能；不能把这一依赖写成整个产品面向所有用户的前提。

当前为 **0.1.0 测试源码版**，需要提供 `pet.conversation` 实验接口的候选宿主。没有发布宿主安装包、npm 包或插件 Release；不能直接假定现有安装版兼容。

## 当前 0.1.0 能做什么（模式二：DSH 适配）

- 连接已有 DSH Session，保留原会话历史和由 DSH 管理的人设、记忆。
- 桌宠主聊天与一个已绑定主人 QQ 好友私聊共用此 Session；两端可互相接着聊。
- 桌面提问只在桌面回答；QQ 提问只向主人 QQ 回答，历史可以在桌面看到。
- 串行处理、重复事件去重、断线状态、手动重连、重启恢复、显式解绑。
- B 站生活不是依赖。本版未启用跨端视频任务，已有 B 站插件不被改动。

首个协议目标为 **DSH 0.2.1-rc.2 + NapCat OneBot v11 正向 WebSocket**。本机 Windows/Linux、其他 DSH 版本及真实登录 QQ 尚未完成验证；当前真实桌宠验证环境是 macOS arm64。

## 当前 DSH 适配的接入步骤

1. 安装本仓库依赖：`npm ci --omit=dev`，在支持该实验接口的测试宿主中从文件夹安装插件，并授权。测试阶段只按已有受邀渠道获取宿主。
2. 在原 DSH 中确认角色、记忆和目标 Session 可继续聊天，记录 Session ID。插件不会创建空会话替代原宠物。
3. 停止旧业务桥接对该 Session 的 QQ 收发，也停用它提供的直接 QQ 发送工具，防止两个桥或模型工具重复投递。仅停止 UI 不足以保证这一点。
4. 在 NapCat 开启 OneBot v11 正向 WebSocket，消息格式选择 **数组**。确保主人是机器人好友，记录地址、访问令牌、机器人 QQ 与主人 QQ。
5. 在插件面板输入两个服务的本机地址、令牌和已有 Session ID，确认旧桥已停用，点击“验证并连接原会话”。连接成功后使用桌宠原来的聊天窗口。

只接受 `127.0.0.1` 或 `localhost` 的根地址。远程部署先通过自己管理的本地端口转发接入。令牌进入宿主加密仓，不放入 URL 配置或普通插件 storage，也不向其他插件提供。

## 范围与恢复

- 这是我们自己的轻量业务桥，复用 NapCat 的 QQ 协议接入。**不兼容所有 Koishi/QQ AI 插件**，不复刻第三方桥接代码。
- 第三方桥单独保存的角色文件、社交关系、MCP 权限和记忆不自动导入。先在原 DSH 确认这些内容已可用，再接入；仅填写同一 Session ID 不能证明这些外挂状态已迁移。
- 只接主人好友私聊文本；群聊、临时私聊、陌生人、自身消息、图片/语音/转发不触发生成。事件超过 5 分钟不补执行。
- 桌宠运行时承担桥接。桌宠退出或离线时不假装后台常驻。
- 断线后在面板重连。未知的提交或 QQ 发送结果不自动重放；请先核对 DSH 与 QQ。去重账本保留最近 24 小时，容量上限 1000 条，达到上限拒绝新请求。
- “停止”等待会取消尚未提交的排队消息，并停止当前请求的等待及结果投递；已提交到 DSH 的回合可能继续执行。DSH 0.2.1 的取消接口作用于整个 Session，因此本版不冒险取消其他入口的回合。
- 绑定后断线、停用或卸载插件不会自动换回本地另一套记忆。需要恢复本地聊天时，在面板点击“解除绑定”；若已停用/卸载，先重新启用/安装再解绑。本地旧历史保留。
- 宿主后台 AI（包括 B 站）仍保持原有语义。本版不宣称后台活动已与 QQ 同步。

## 开发与验证

```sh
npm test
QQ_TEST_DSH_BIN=/path/to/dsh/lib/bin.js npm run test:dsh-live
PET_PLUGIN_HOST_DIR=/path/to/host/demo npm run test:e2e
```

`test:delivery` 顺序运行以上三层，需要两个环境变量。DSH 必须安装固定的 `@deepseek-ai/dsh@0.2.1-rc.2`；测试使用临时 `DSH_HOME`，不会读取日常 DSH 配置。Electron 使用独立 profile、专用 CDP 端口和首帧隐藏。

真实 DSH 测试用本地 SSE 模型服务核查实际模型请求携带之前的对话；QQ 用 OneBot 协议服务器。**这证明接口、上下文传递和路由，不证明真实模型理解质量或真实 QQ 登录收发。** 验证说明见 [首版记录](docs/v1-delivery.md)。

协议依据：[DSH Session Controller](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.2/packages/api/session-controller)、[NapCat 集成说明](https://napneko.github.io/use/integration)、[OneBot v11](https://github.com/botuniverse/onebot-11)。
