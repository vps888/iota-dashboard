# iota-dashboard

IOTA Train at Home 矿机在线监控面板,部署于 Cloudflare Pages。

数据全部来自 Macrocosmos 公开接口(经 Pages Functions 服务端代理,规避 CORS),每 60 秒自动刷新。

## 功能

- **矿机状态**:在线状态、吞吐量、激活数、训练任务、模型分区、全网排名、下次支付时间
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
