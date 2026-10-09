# miner-agent

IOTA Train at Home 本地守护与状态上报工具（macOS）。

独立社区工具,不是官方客户端。已在 Apple Silicon Mac 上使用;不修改官方应用、签名或系统安全设置,不读取钱包文件。

## 功能

- **守护矿机**:每 30 秒检查官方应用与矿工进程、本地控制服务(`127.0.0.1:8010`)、官方日志;连续三次本地异常才自动重启,带五分钟启动宽限、十五分钟重启退避、每小时最多三次;正常排队与正常退出绝不重启
- **优化启动**:先启动仅监听 `127.0.0.1:18010` 的本地中继(等待真实矿工最多 180 秒,不伪造健康响应),再以中继地址拉起官方应用
- **状态上报**(默认关闭):经你显式授权后,每 30 秒向 [iota-dashboard](https://github.com/) 仪表盘发送脱敏状态
- **NOID 负载调度**(默认关闭):显式启用后,排队/等待时自动运行 NOID 默认负载;IOTA 有实际训练活动时保持矿池连接并将 CPU/GPU 占空比降至 10%;监控失败或状态未知时恢复默认负载

## 安装

```bash
npm install -g miner-agent
```

要求:macOS、Node 20+、已安装官方 IOTA Train at Home.app。

## 使用

```bash
# 1. 安装登录后自动运行的守护(LaunchAgent)
miner-agent install

# 2. 优化启动(替代直接打开官方应用)
miner-agent start

# 3. 查看最近守护结果
miner-agent status

# 4. 可选:安装自编译定制版 NOID Miner 后启用 IOTA 优先调度
miner-agent noid enable
# 可选指定应用包路径
miner-agent noid enable --app "/Applications/NOID Miner.app"
miner-agent noid status
miner-agent noid disable  # 恢复默认负载,不停止矿工

# 5. 启用状态上报:先在仪表盘页面点「生成配对令牌」
miner-agent report --enable --token <令牌> --url <仪表盘地址> --miner <Miner-ID>

# 停用上报 / 卸载守护
miner-agent report --disable
miner-agent uninstall
```

数据文件位于 `~/.miner-agent/`(权限 0600):`config.json`(配置)、`state.json`(守护状态)、`guardian.log`(事件日志)。

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

## NOID 调度

先按 `packages/noid-mac-miner/README.md` 构建并安装定制版到 `/Applications/NOID Miner.app`。退出正在运行的旧版后再做切换；守护发现有 NOID 进程但没有控制 socket 时会拒绝启动第二个实例，不会停止旧矿工。启用后,agent 在 IOTA 非训练态自动启动 NOID；训练态将 CPU/GPU 占空比设为 10%，保持现有矿池会话；监控失败或状态未知时恢复默认负载。调度只使用本机 Unix socket (`~/Library/Application Support/NOID Miner/control.sock`)，不会经状态上报传出 NOID 运行信息或钱包地址。禁用调度只恢复默认负载，不停止矿工。


MIT
