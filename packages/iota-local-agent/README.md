# miner-agent

CLI 简写：安装后使用 `ma` 命令（npm 包名仍为 `miner-agent`）。

macOS 本地 IOTA Train at Home 守护与飞书控制工具。只管理 IOTA，不集成 NOID，也不再向 miner.zhetengxia.com 上报数据。官方状态与收益直接从 Macrocosmos API 查询。

## 安装与启动

```bash
npm install -g miner-agent@0.2.11
ma install       # 设置登录后自动启动（守护；若飞书已配对也会启动机器人）
ma start         # 启动 IOTA（已运行时不重复启动）
ma status        # 查看 IOTA、守护与飞书状态
ma stop          # 停止 IOTA 与 main_pool，监控服务继续运行
```

守护默认每 30 秒检查 IOTA 主程序、全部 main_pool 子进程、控制服务和日志。检测到进程退出、控制连接异常、P2P 异常、低速测速或其他矿工异常时，只通过飞书告警，不会自动重启 IOTA；是否重启由你决定，并可通过飞书「重启」命令执行。异常告警会去重，恢复后再次发生会重新告警。

## 飞书机器人配置

飞书使用官方应用机器人和 WebSocket 长连接，不需要公网服务器、域名、Webhook 回调服务器或开放本机端口。机器人程序需要在这台 Mac 上运行并联网。

1. 在[飞书开放平台](https://open.feishu.cn/app)创建企业自建应用、启用机器人能力，并配置收发消息权限和 `im.message.receive_v1` 长连接事件。发布应用后才会生效；无需公网服务器或回调地址。
2. Mac 上运行 `ma feishu setup`，只输入 App ID 和 App Secret。Agent 会从本机 Bittensor 钱包公钥文件自动发现账户地址；不会打开无扩展名的私钥文件，也不读取私钥或助记词。若本机存在多个公钥，会优先采用与当前 IOTA 钱包日志匹配的账号，并显示选择结果。
3. 只有本机确实检测到多个 Miner ID 时，才需要用 `ma miner list` 查看并通过 `ma miner select <序号>` 切换。随后运行 `ma feishu connect`，在飞书里给机器人发任意单聊消息完成自动配对。配对后机器人服务会自动安装并启动。`ma install` 设置守护与已配对机器人登录后自动启动；更新 npm 包后运行 `ma feishu restart`，让飞书服务重新加载新版本。`start/stop/status` 用于日常 IOTA 操作。

机器人命令：

- **状态**：实时获取本机守护状态、IOTA 与 main_pool 进程、队列/训练日志、控制连接；并查询官方 Miner 状态、吞吐/激活/Token 采样和全网训练容量。
- **重启**：按优化启动流程先结束 IOTA 主进程、等待 3 秒，再结束 main_pool、等待 5 秒，最后在清除常见代理环境变量的环境中启动；随后等待测速，最多 15 分钟并返回启动结果和测速值。
- **收益**：返回官方接口提供的累计已赚、已付、待付、冻结与最低支付额度，以及完整收益历史列表。

> 远程重启属于高权限操作。配对时只允许当前单聊账号控制；飞书应用 Secret 应视为密码。

## 本地数据

`~/.miner-agent/` 保存飞书凭据、守护状态、进程监控基线和事件日志。飞书机器人保持长连接，但用户消息仅在允许列表内处理。未配置飞书机器人时，不发送飞书消息。进程退出、控制连接或测速等异常告警由已连接的机器人推送，无需另配 webhook。
