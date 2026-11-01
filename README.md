# QQ 宠物连接

连接已有 QQ 宠物与桌面聊天，共用原会话上下文。首个适配目标为 NapCat OneBot v11 与 DSH；B 站生活联动为可选扩展，不是安装或使用前提。

当前为 **0.1.0 测试源码版**，需要提供 `pet.conversation` 实验接口的候选宿主。没有发布宿主安装包、npm 包或插件 Release；不能直接假定现有安装版兼容。

## 首版能做什么

- 连接已有 DSH Session，保留原会话历史和由 DSH 管理的人设、记忆。
- 桌宠主聊天与一个已绑定主人 QQ 好友私聊共用此 Session；两端可互相接着聊。
- 桌面提问只在桌面回答；QQ 提问只向主人 QQ 回答，历史可以在桌面看到。
- 串行处理、重复事件去重、断线状态、手动重连、重启恢复、显式解绑。
- B 站生活不是依赖。本版未启用跨端视频任务，已有 B 站插件不被改动。

首个协议目标为 **DSH 0.2.1-rc.2 + NapCat OneBot v11 正向 WebSocket**。本机 Windows/Linux、其他 DSH 版本及真实登录 QQ 尚未完成验证；当前真实桌宠验证环境是 macOS arm64。

## 接入步骤

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
