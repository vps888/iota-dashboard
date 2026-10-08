# iota-agent

IOTA Train at Home 本地守护与状态上报工具（macOS）。

独立社区工具,不是官方客户端。已在 Apple Silicon Mac 上使用;不修改官方应用、签名或系统安全设置,不读取钱包文件。

## 功能

- **守护矿机**:每 30 秒检查官方应用与矿工进程、本地控制服务(`127.0.0.1:8010`)、官方日志;连续三次本地异常才自动重启,带五分钟启动宽限、十五分钟重启退避、每小时最多三次;正常排队与正常退出绝不重启
- **优化启动**:先启动仅监听 `127.0.0.1:18010` 的本地中继(等待真实矿工最多 180 秒,不伪造健康响应),再以中继地址拉起官方应用
- **状态上报**(默认关闭):经你显式授权后,每 30 秒向 [iota-dashboard](https://github.com/) 仪表盘发送脱敏状态

## 安装

```bash
npm install -g iota-agent
```

要求:macOS、Node 20+、已安装官方 IOTA Train at Home.app。

## 使用

```bash
# 1. 安装登录后自动运行的守护(LaunchAgent)
iota-agent install

# 2. 优化启动(替代直接打开官方应用)
iota-agent start

# 3. 查看最近守护结果
iota-agent status

# 4. 启用状态上报:先在仪表盘页面点「生成配对令牌」
iota-agent report --enable --token <令牌> --url <仪表盘地址> --miner <Miner-ID>

# 停用上报 / 卸载守护
iota-agent report --disable
iota-agent uninstall
```

数据文件位于 `~/.iota-agent/`(权限 0600):`config.json`(配置)、`state.json`(守护状态)、`guardian.log`(事件日志)。

## 上报内容与隐私

上报**仅含**:守护状态分类、描述文本、队列位置、控制连接布尔值、重启计数、运行时长、操作系统类型、代理版本。

上报**绝不含**:主机名、文件路径、PID、日志内容、钱包或任何密钥。上报默认关闭,令牌在云端只存 SHA-256 哈希,90 天自动过期。不上报时工具完全不产生网络请求(除官方应用自身)。

## 状态分类

| 状态 | 含义 | 会重启吗 |
|---|---|---|
| paused | 从未启动 / 正常退出 / 矿工正常停止 | 否 |
| starting | 启动中(五分钟宽限) | 否 |
| queued | 官方排队中(位置 15 分钟未更新也只提示) | 否 |
| training | 最近五分钟有实际训练活动 | 否 |
| waiting | 控制连接正常,等待任务 | 否 |
| abnormal | 主程序/矿工退出、控制服务不可访问、30 分钟无活动 | 连续 3 次后重启 |

## License

MIT
