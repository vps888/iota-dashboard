# mac-miner

mac-miner 是面向 Apple Silicon 的 IOTA/NOID 挖矿调度与监控工具，包含在线仪表盘和本地 Agent。项目仍在早期开发阶段。

IOTA 官方数据来自 Macrocosmos 公开接口；本机 miner-agent 数据只有在用户生成配对令牌并显式开启上报后才发送。页面每 60 秒自动刷新。

## 功能

- **IOTA 状态**:官方采样状态、吞吐量、激活数、训练任务、模型分区；区分名单覆盖不足与确认未找到
- **本地调度**:排队时使用 NOID 默认负载；IOTA 确认训练时降低 NOID CPU/GPU 目标占空比
- **NOID 遥测**(可选):本地上报调度模式、CPU/GPU 目标、算力和份额计数；不上传钱包、地址或能耗
- **训练记录**:近一周非零训练采样点列表
- **全网状态**:所有训练任务的名额、在线矿机、剩余名额、占用率
- **收益记录**:今日/累计 IOTA 收益、每日支付记录(最新在前,可滚动)

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

## Cloudflare Pages（备用部署）

```bash
npm run deploy
```

或在 Cloudflare Pages 控制台连接仓库:构建命令 `npm run build`,输出目录 `dist/web`。

部署前需要创建 KV namespace 并把 ID 填入 `wrangler.json` 的 `CACHE` 绑定(token、本地上报与仪表盘缓存共用一个 namespace,按前缀区分)。本仓库已配置好(namespace `CACHE`,`1a3972fdf0c1402e95ccb4d5f7e71177`),如需重建:

```bash
npx wrangler kv namespace create CACHE
```

## Ubuntu Docker 自托管

Docker 镜像包含在线页面、Pages API 路由的 Node 运行时和 SQLite 持久 KV。Cloudflare Pages 部署可保留作回滚；Docker 数据库不自动导入旧 Cloudflare KV，切换后需要在新站点重新生成配对令牌并更新本机 miner-agent。

本机先构建并启动 HTTP 服务（默认只绑定 `127.0.0.1:8788`）：

```bash
docker compose build
docker compose up -d
curl http://127.0.0.1:8788/healthz
```

SQLite 文件持久保存在 `mac-miner-data` named volume；不得删除该 volume 来清理容器。公网部署需把 `miner.zhetengxia.com` DNS 指向服务器，并确认 80/443 端口空闲或准备接入现有反向代理。端口空闲且 DNS 生效后，可启用随仓库提供的 Caddy profile 获取 HTTPS：

```bash
docker compose --profile public up -d
```

该 profile 会绑定主机 80/443；服务器上有现有服务监听时不要启动它，先配置现有代理转发到 `127.0.0.1:8788`。容器以非 root 用户运行，数据库路径/凭据不烘焙进镜像；`.env.local` 被 `.dockerignore` 排除。

备份前暂停容器，再把 named volume 内容复制到安全位置；恢复前应暂停服务并保留原数据库副本。Cloudflare KV 中的 token/report 不会自动迁移，旧站点在完成验证前保持在线。

## miner-agent 本地守护与上报（macOS）

`packages/iota-local-agent` 是从社区 Python 工具移植的 Node/TypeScript 守护,安装在本机后可:

1. **守护矿机**:每 30 秒检查官方应用与矿工进程、本地控制服务、官方日志;连续三次异常才自动重启(五分钟启动宽限、十五分钟退避、每小时最多三次);排队与正常退出绝不重启
2. **优化启动**:先启动仅监听 `127.0.0.1:18010` 的本地中继(等待真实矿工最多 180 秒,不伪造健康),再以中继地址拉起官方应用
3. **状态上报**(默认关闭):经用户显式授权后,每 30 秒向仪表盘发送脱敏状态

### 安装与使用

```bash
npm run build --workspace=iota-local-agent
# 安装登录后自动运行的守护(LaunchAgent)
npm exec --workspace=iota-local-agent -- miner-agent install
# 优化启动(替代直接打开官方应用)
npm exec --workspace=iota-local-agent -- miner-agent start
# 查看最近守护结果
npm exec --workspace=iota-local-agent -- miner-agent status
```

### 启用状态上报

在仪表盘页面点击「生成配对令牌」(绑定当前 Miner ID,只显示一次),然后在矿机上:

```bash
miner-agent report --enable --token <令牌> --url <仪表盘地址> --miner <Miner-ID>
```

上报内容仅限:守护状态、队列位置、控制连接、重启次数、运行时长、系统类型、代理版本；定制 NOID 调度启用时附带当前模式、CPU/GPU 目标占空比、算力和份额计数。**不含**钱包/私钥、主机名、文件路径、PID、日志、收益或电耗。令牌在云端只存 SHA-256 哈希,90 天自动过期;停用上报随时执行 `miner-agent report --disable`。数据文件位于 `~/.miner-agent/`(权限 0600)。

### 卸载

```bash
miner-agent uninstall   # 停止并移除 LaunchAgent(矿机保持运行)
rm -rf ~/.miner-agent   # 可选:清理配置与状态文件
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
