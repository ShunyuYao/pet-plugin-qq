# 吐梨邦 · QQ 宠物连接插件

`pet-plugin-qq` 是 **吐梨邦（Turi Topia）的 QQ 连接插件**。当前 **0.3.0-dev.3 本地开发候选**使用腾讯官方 `qqbot-nodejs 1.0.5` 接入 QQ，新增绑定单个本人的单轮私聊测试入口，支持群 OpenID 发现、收发与 SDK 会话恢复，保留 NapCat 和已有 DSH 宠物私聊适配。群反馈助手收集指定群的新消息、响应真实 @、整理带原话的 bug 和建议，在同一个测试桌宠查看和追问。

**B 站生活联动是可选项**，核心聊天无需安装、登录或启用 B 站插件；本版尚未启用跨端视频任务。

群助手可选官方机器人（无需 NapCat 登录普通 QQ）或保留旧 NapCat 接入，不需要 DSH。模型沿用宿主配置，但群请求不读桌面私人历史、长期记忆或工具。**需配套支持隔离 AI 任务的候选宿主；已完成本人真实 QQ 私聊及两人测试群 @ 消息入库／回复验证，普通全量群消息、模型反馈质量与长期运行仍未完成验收，不能当成正式上线版。** 先看 [使用说明](docs/group-feedback-quickstart.md) 和 [SDK 迁移记录](docs/official-sdk-migration.md)。首版不做跨设备同步、自动工单或群内广播内部分析。

当前 SDK 迁移边界与验证见 [迁移记录](docs/official-sdk-migration.md)。群模式的 C2C 仅显示收件计数；独立的 [QQ 官方私聊](docs/official-private-trial.md) 页可在暂停群采集后绑定本人，使用隔离模型进行单轮文字回复，不保存聊天正文、不开放本机工具，也不替代完整私聊记忆接续。

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

<!-- turitopia:marketplace:start -->
## 市场上线状态

| 项目 | 当前情况 |
| --- | --- |
| 上架状态 | **未上架**，目前不能从吐梨邦插件市场安装 |
| 市场版本 | 无；源码为 0.3.0-dev.3 开发候选，尚无插件 Release |
| 最近核实 | 2026-11-02 |
| 核实依据 | [正式登记清单固定快照](https://github.com/ShunyuYao/pet-plugin-registry/blob/b537846bdbe7a7e8dcdfc26b8e709f8552eb11dd/registry/plugins.json)中没有插件 ID `qq-context`；[禁用清单固定快照](https://github.com/ShunyuYao/pet-plugin-registry/blob/b537846bdbe7a7e8dcdfc26b8e709f8552eb11dd/registry/blocklist.json)没有该插件记录；[Release 列表](https://github.com/ShunyuYao/pet-plugin-qq/releases)为空 |
| 应用内验证 | 尚未验证市场可见与市场下载安装；已有本地插件加载、真实 Electron 和 DSH 测试不等于市场上线验证 |

以上是核实日期时的状态。市场发布后需更新本节；当前测试源码的安装方式见下文。
<!-- turitopia:marketplace:end -->

## 本插件能做什么

新增群反馈模式：

- 面板配置指定群、采集说明、保留期限和容量；查看连接与整理进度，暂停、恢复、清理。
- 结构化采集文本、@、引用及非文本占位并去重；按群保存近期上下文、带来源的批次摘要。NapCat 提供撤回通知，官方普通群撤回通知尚未验证。
- 显式开启模型并设置每日调用次数预算后整理候选反馈；另开 @ 回复后只向原群发送一次。
- 查看原话，人工纠正、确认、忽略、拆分与关联反馈；桌宠主聊天通过只读工具查反馈和来源。
- 已收到的撤回事件／保留期到期使相关摘要和反馈失效；未知发送结果不自动重发。不承诺官方普通群撤回自动同步。

保留 **模式二中的 DSH 适配**：

- 连接已有 DSH Session，保留原会话历史和由 DSH 管理的人设、记忆。
- 桌宠主聊天与一个已绑定主人 QQ 好友私聊共用此 Session；两端可互相接着聊。
- 桌面提问只在桌面回答；QQ 提问只向主人 QQ 回答，历史可以在桌面看到。
- 串行处理、重复事件去重、断线状态、手动重连、重启恢复、显式解绑。
- B 站生活不是依赖。本版未启用跨端视频任务，已有 B 站插件不被改动。

### 两种模式与开发优先级

两种模式都在产品范围内，**优先实现模式一**。完整决策、配置门槛、调研依据及后续验收见 [产品模式与优先级](docs/product-modes.md)。

| 模式 | 用户目标 | 是否需要另外安装 DSH | 当前状态 |
| --- | --- | --- | --- |
| **模式一 · 当前桌宠接入 QQ** | 复用桌宠模型与人设，群上下文与私人记忆隔离 | **不需要**；另行准备 QQ 接入 | 群反馈试点已实现开发候选，真实 QQ 待验收；普通主人私聊的本地主记忆延续仍待做 |
| **模式二 · 同样必做：连接已有 QQ 宠物** | 将原 QQ 宠物接到桌面，保留其历史、人设和记忆 | 取决于原后端；DSH 用户复用原服务，其他后端需要相应适配 | 已实现 DSH + NapCat 的测试源码版；其他后端未适配 |

## 安装与配置

### 群反馈助手（新模式，推荐首个试点）

先读 [完整启动与使用说明](docs/group-feedback-quickstart.md)。在配套候选宿主中从文件夹安装并授权本插件；打开面板的「群反馈助手」，配置本机 NapCat、机器人、群白名单、数据期限和模型预算。此模式不填写 DSH 地址或 Session ID。

开发者可 `npm run package:local` 生成不含运行数据的本地安装目录，或 `PET_PLUGIN_HOST_DIR=/absolute/candidate-host/demo npm run pilot` 启动独立可见试点实例。不会自动登录、授权或配置真实 QQ；不要并发运行同一 profile。

### 连接已有 DSH 宠物（保留的旧模式）

以下步骤仅适用于模式二，不是群反馈模式的前置依赖。准备好：

- 提供 `pet.conversation` 实验接口的吐梨邦候选宿主；目前没有可对外承诺的最低发行版，不能直接假定现有安装版兼容。测试阶段通过已有受邀渠道获取宿主。
- 已运行的 **DSH 0.2.1-rc.2** 和原宠物的 Session ID。DSH 管理此模式的会话、模型配置、人设和记忆；插件不会自动安装或启动 DSH，也不会创建空会话替代原宠物。
- 已准备好的 **NapCat OneBot v11 正向 WebSocket** 接入，以及互为好友的主人 QQ 和机器人 QQ。NapCat 负责 QQ 收发，模型沿用所连接 DSH 的配置。
- 本仓库源码及 **Node.js ≥ 22.19**，用于安装依赖和开发验证。

### 连接已有 DSH 宠物

1. 安装本仓库依赖：`npm ci --omit=dev`，在支持该实验接口的测试宿主中从文件夹安装插件，并授权。测试阶段只按已有受邀渠道获取宿主。
2. 在原 DSH 中确认角色、记忆和目标 Session 可继续聊天，记录 Session ID。插件不会创建空会话替代原宠物。
3. 停止旧业务桥接对该 Session 的 QQ 收发，也停用它提供的直接 QQ 发送工具，防止两个桥或模型工具重复投递。仅停止 UI 不足以保证这一点。
4. 在 NapCat 开启 OneBot v11 正向 WebSocket，消息格式选择 **数组**。确保主人是机器人好友，记录地址、访问令牌、机器人 QQ 与主人 QQ。
5. 在插件面板输入两个服务的本机地址、令牌和已有 Session ID，确认旧桥已停用，点击“验证并连接原会话”。连接成功后使用桌宠原来的聊天窗口。

地址只接受 `127.0.0.1` 或 `localhost` 的根地址，不能包含账号、密码、查询参数或片段。远程部署需先自行建立本地端口转发；本版没有远程一键连接功能。

## 使用

连接后，面板会显示“原会话已连接”。打开吐梨邦原来的主聊天窗口即可继续原会话，无需在插件面板另外聊天。

例如，在桌面说“我们聊聊周末去杭州的计划”，等回复后，再通过主人 QQ 与机器人好友私聊说“接着刚才的话题，列一下要准备的东西”。两次输入进入同一个 DSH Session；桌面提问只在桌面回答，QQ 提问只向主人 QQ 回答，历史可以在桌面查看。这是使用示例，真实模型的理解质量仍需实际验证。

### 断线、停止与解绑

- 面板显示断线时，点击“重新连接”；结果待核对的消息先到 DSH 和 QQ 检查，避免重复提交。
- 聊天中停止等待，不会回滚已提交到 DSH 的回合。
- 要恢复桌宠本地聊天，在插件面板点击“解除绑定，恢复本地聊天”。若插件已停用或卸载，需先重新启用或安装再解绑；原本地聊天记录保留。

## 权限与数据

实际申请的权限见 [manifest.json](manifest.json)。

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存不含访问令牌的连接配置，包括服务地址、Session ID、主人 QQ 和机器人 QQ。 |
| `secrets` | 加密保存连接凭据和消息处理账本，支持恢复连接和重复消息去重。 |
| `events` | 响应账号或宠物身份切换，关闭旧连接并恢复对应身份的绑定。 |
| `ui` | 提供连接设置、状态、重连和解绑面板。 |
| `conversation` | 将桌宠主聊天绑定到已有 DSH 会话，读取历史、提交输入和返回回复。 |
| `ai` | 按操作者显式预算调用宿主隔离模型，不读取私人历史，不自动写入桌宠经历。 |
| `tools` | 注册主人主聊天中的只读反馈查询；群后台任务不能调用此工具。 |
| `net:127.0.0.1`、`net:localhost` | 连接配置的本机 DSH 与 NapCat 服务。 |

连接配置和账本按当前账号与宠物的作用域分别保存。访问令牌存入宿主加密仓，不写入普通插件 storage；面板状态不返回令牌，连接和解绑操作仅接受本插件面板调用。认证时会把凭据发送给对应的已配置服务。

旧 DSH 私聊账本包含消息文本、回复、来源、处理状态、时间和可能的 QQ 回执，按原有 24 小时／1000 条规则维护；解绑不自动删除旧账本。群模式使用独立加密资料库，按配置保留原文，撤回／过期移除派生内容并保留去重墓碑，详见 [群助手数据与清理说明](docs/group-feedback-quickstart.md)。本批为 8 MiB 上限试点快照，不承诺无限群历史或长时间高流量容量。

聊天输入发送到 DSH，由 DSH 按原配置调用模型和工具；QQ 来源的回复经 NapCat 发给已绑定主人。因此，即使连接地址是本机地址，聊天内容仍可能由 DSH 发往其配置的远程服务，并由 NapCat 通过 QQ 发送。原会话历史由 DSH 管理，插件不读取宿主私有聊天库；解绑不删除 DSH 历史或原桌宠本地记录。

## 当前状态

| 项目 | 状态与验证范围 |
| --- | --- |
| 源码版本 | 0.3.0-dev.3 开发候选；尚无插件 Release 或市场安装包。 |
| 已验证 | macOS arm64 下的本地协议回归、真实 DSH 0.2.1-rc.2 进程，以及真实 Electron 中的插件加载、双向接续、去重、离线、重连、重启恢复和解绑。 |
| 测试环境 | DSH 使用本地 SSE 模型服务，QQ 使用 OneBot 协议测试服务；不是已登录 QQ 的实机验收。 |
| 尚未验证 | 真实 QQ/NapCat 登录收发、真实远程 DSH 部署、真实模型理解质量、Windows/Linux 和其他 DSH 版本。 |
| 新增 | 群采集、面板、受控模型调用、@ 回复、反馈整理／人工处理和主聊天查询；见 [本批说明](docs/group-feedback-v1.md)。 |
| 尚未实现 | 模式一的普通主人私聊记忆延续、非 DSH 后端适配、第三方角色／社交状态自动迁移、B 站跨端联动。 |

以上测试的环境、范围和证据见 [0.1.0 首版记录](docs/v1-delivery.md)。市场可见与下载安装仍未验证。

### 旧 DSH 私聊模式的范围与恢复细节

- 这是我们自己的轻量业务桥，复用 NapCat 的 QQ 协议接入。**不兼容所有 Koishi/QQ AI 插件**，不复刻第三方桥接代码。
- 第三方桥单独保存的角色文件、社交关系、MCP 权限和记忆不自动导入。先在原 DSH 确认这些内容已可用，再接入；仅填写同一 Session ID 不能证明这些外挂状态已迁移。
- 只接主人好友私聊文本；群聊、临时私聊、陌生人、自身消息、图片/语音/转发不触发生成。事件超过 5 分钟不补执行。
- 桌宠运行时承担桥接。桌宠退出或离线时不假装后台常驻。
- 断线后在面板重连。未知的提交或 QQ 发送结果不自动重放；请先核对 DSH 与 QQ。去重账本容量上限为 1000 条，达到上限拒绝新请求；清理时机见“权限与数据”。
- “停止”等待会取消尚未提交的排队消息，并停止当前请求的等待及结果投递；已提交到 DSH 的回合可能继续执行。DSH 0.2.1 的取消接口作用于整个 Session，因此本版不冒险取消其他入口的回合。
- 绑定后断线、停用或卸载插件不会自动换回本地另一套记忆。需要恢复本地聊天时，在面板点击“解除绑定”；若已停用/卸载，先重新启用/安装再解绑。本地旧历史保留。
- 宿主后台 AI（包括 B 站）仍保持原有语义。本版不宣称后台活动已与 QQ 同步。

反馈问题请使用 [GitHub Issues](https://github.com/ShunyuYao/pet-plugin-qq/issues)，附插件版本、宿主版本、操作系统和复现步骤，隐去访问令牌与私人聊天内容。

## 开发

在仓库根目录运行 `npm ci` 安装依赖，再执行：

```sh
npm test
npm run test:group
npm run test:feedback
PET_PLUGIN_HOST_DIR=/absolute/candidate-host/demo npm run test:group:delivery
QQ_TEST_DSH_BIN=/path/to/dsh/lib/bin.js npm run test:dsh-live
PET_PLUGIN_HOST_DIR=/path/to/host/demo npm run test:e2e
```

`test:delivery` 顺序运行以上三层，需要两个环境变量。DSH 必须安装固定的 `@deepseek-ai/dsh@0.2.1-rc.2`；测试使用临时 `DSH_HOME`，不会读取日常 DSH 配置。Electron 使用独立 profile、专用 CDP 端口和首帧隐藏。

真实 DSH 测试用本地 SSE 模型服务核查实际模型请求携带之前的对话；QQ 用 OneBot 协议服务器。**这证明接口、上下文传递和路由，不证明真实模型理解质量或真实 QQ 登录收发。** 验证说明见 [首版记录](docs/v1-delivery.md)。

协议依据：[DSH Session Controller](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.2/packages/api/session-controller)、[NapCat 集成说明](https://napneko.github.io/use/integration)、[OneBot v11](https://github.com/botuniverse/onebot-11)。

## 开源协议

当前 QQ 插件源码尚未声明开源许可证，仓库没有适用于整个插件的 `LICENSE` 文件。

README 的模板结构和通用说明来自采用 MIT License 的 [Turi Topia 插件文档](https://github.com/ShunyuYao/turitopia-plugin-docs)，其原版权和许可声明保存在 [模板 MIT 许可声明](docs/licenses/turitopia-plugin-docs-MIT.txt)。该声明适用于复用的模板内容，插件源码的许可证需单独确定。

README 规范：[Turi Topia 插件文档](https://github.com/ShunyuYao/turitopia-plugin-docs)。本次采用的模板版本为 [`0197d5d`](https://github.com/ShunyuYao/turitopia-plugin-docs/tree/0197d5d)。
