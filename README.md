# iota-dashboard

IOTA Train at Home 矿机在线监控面板,部署于 Cloudflare Pages。

数据全部来自 Macrocosmos 公开接口(经 Pages Functions 服务端代理,规避 CORS),每 60 秒自动刷新。

## 功能

- **矿机状态**:官方采样状态、吞吐量、激活数、训练任务、模型分区；区分名单覆盖不足与确认未找到
- **本地状态**:本机 iota-agent 守护的实时上报(守护状态、队列位置、控制连接、自动重启),与官方遥测互补;超过 2.5 分钟无上报标记为离线
- **训练记录**:近一周非零训练采样点列表
- **全网状态**:所有训练任务的名额、在线矿机、剩余名额、占用率
- **收益记录**:今日/累计收益(IOTA/USD)、每日支付记录(最新在前,可滚动)

## 开发

```bash
npm install
npm run build        # 构建前端到 dist/web
npm run typecheck    # TypeScript 检查
npx wrangler pages dev dist/web --port 8788 --compatibility-date 2026-05-01   # 本地运行 Functions
npm run dev          # Vite 开发服务器(代理 /api 到 8788)
```

## 使用

首次打开页面时输入 Miner ID(SS58 hotkey,可在 IOTA 应用 Miner 页面复制),保存于浏览器 localStorage;之后访问不再提示,可通过右上角「更换 Miner ID」重新输入。

## 部署

```bash
npm run deploy
```

或在 Cloudflare Pages 控制台连接仓库:构建命令 `npm run build`,输出目录 `dist/web`。

部署前需要创建 KV namespace 并把 ID 填入 `wrangler.json` 的 `CACHE` 绑定(token、本地上报与仪表盘缓存共用一个 namespace,按前缀区分)。本仓库已配置好(namespace `CACHE`,`1a3972fdf0c1402e95ccb4d5f7e71177`),如需重建:

```bash
npx wrangler kv namespace create CACHE
```

## iota-agent 本地守护与上报（macOS）

`packages/iota-local-agent` 是从社区 Python 工具移植的 Node/TypeScript 守护,安装在本机后可:

1. **守护矿机**:每 30 秒检查官方应用与矿工进程、本地控制服务、官方日志;连续三次异常才自动重启(五分钟启动宽限、十五分钟退避、每小时最多三次);排队与正常退出绝不重启
2. **优化启动**:先启动仅监听 `127.0.0.1:18010` 的本地中继(等待真实矿工最多 180 秒,不伪造健康),再以中继地址拉起官方应用
3. **状态上报**(默认关闭):经用户显式授权后,每 30 秒向仪表盘发送脱敏状态

### 安装与使用

```bash
npm run build --workspace=iota-local-agent
# 安装登录后自动运行的守护(LaunchAgent)
npm exec --workspace=iota-local-agent -- iota-agent install
# 优化启动(替代直接打开官方应用)
npm exec --workspace=iota-local-agent -- iota-agent start
# 查看最近守护结果
npm exec --workspace=iota-local-agent -- iota-agent status
```

### 启用状态上报

在仪表盘页面点击「生成配对令牌」(绑定当前 Miner ID,只显示一次),然后在矿机上:

```bash
iota-agent report --enable --token <令牌> --url <仪表盘地址> --miner <Miner-ID>
```

上报内容仅限:守护状态、描述、队列位置、控制连接、重启次数、运行时长、系统类型、代理版本。**不含**主机名、文件路径、PID、日志内容或任何密钥。令牌在云端只存 SHA-256 哈希,90 天自动过期;停用上报随时执行 `iota-agent report --disable`。数据文件位于 `~/.iota-agent/`(权限 0600)。

### 卸载

```bash
iota-agent uninstall   # 停止并移除 LaunchAgent(矿机保持运行)
rm -rf ~/.iota-agent   # 可选:清理配置与状态文件
```

## npm CLI（实验性）

工作区提供与仪表盘共用的官方 Miner ID 状态查询命令：

```bash
npm run build --workspace=iota-miner-tools
npm exec --workspace=iota-miner-tools -- iota-miner <Miner-ID>
npm exec --workspace=iota-miner-tools -- iota-miner <Miner-ID> --json
```

当前 CLI 直接读取 Macrocosmos 公开接口，只查询官方采样状态，不读取或控制本机矿机。

## 本地工具（macOS）

`tools/iota-local/` 是从社区参考实现移植的独立本地守护工具，用于查看和控制**本机**的官方 IOTA 应用（与网页端互不相通，本地状态不上传）。

- **安装**：双击 `tools/iota-local/安装IOTA工具.command`（为当前用户安装守护并注册登录启动，文件位于 `~/Library/Application Support/IOTA Local Guardian/`）
- **优化启动**：先从 IOTA 菜单正常退出，再双击 `IOTA优化启动.command`（通过本地中继启动，控制连接最多等待矿工 180 秒）
- **查看状态**：双击 `查看IOTA状态.command`（每 60 秒刷新；后台守护每 30 秒检查一次）。也可手动执行一次只读检查：

```bash
/usr/bin/python3 tools/iota-local/runtime/iota_guardian.py --once
```

- **自动重启保护**：连续三次本地异常才重启；五分钟启动宽限、十五分钟重启退避、每小时最多三次；正常排队、正常退出不触发重启
- **停止/卸载**：`停止IOTA守护.command` 停止后台守护（不影响矿工）；完整卸载见 `tools/iota-local/README.md`

要求：macOS、已安装官方 IOTA Train at Home.app、`/usr/bin/python3` 为 3.9+。仅在 Apple Silicon 与官方客户端 3.7.0 上验证过。守护的检查与重启语义由 `tools/tests/test_iota_tools.py` 锁定，随 `npm test` 一并运行。
