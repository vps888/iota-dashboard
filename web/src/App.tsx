import { useMemo, useState, type ReactElement } from 'react'
import { useDashboard, getSavedMinerId, saveMinerId, clearMinerId, isValidMinerId, createToken } from './api.js'
import { toTrainingRows } from './types.js'
import { fmtNum, fmtIota, fmtUsd, fmtTime, fmtDate, fmtPct, fmtAgo, fmtContributionTime } from './format.js'
import type { OfficialStatus } from '../../packages/iota-miner-tools/src/types.js'
import type { LocalReport } from './api.js'

const LOOKUP_STATUS: Record<OfficialStatus, { label: string; tone: string }> = {
  contributing: { label: '官方采样：有训练贡献', tone: 'positive' },
  waiting: { label: '官方采样：在线待任务', tone: 'positive' },
  idle: { label: '官方采样：暂未参与', tone: 'warning' },
  not_found: { label: '完整名单中未找到', tone: 'negative' },
  unknown: { label: '状态待确认', tone: 'neutral' },
  refresh_interrupted: { label: '官方数据刷新中断', tone: 'neutral' },
}

const LOCAL_STATUS: Record<LocalReport['status'], { label: string; tone: string }> = {
  training: { label: '本地代理：训练中', tone: 'positive' },
  waiting: { label: '本地代理：待任务', tone: 'positive' },
  queued: { label: '本地代理：排队中', tone: 'warning' },
  starting: { label: '本地代理：启动中', tone: 'warning' },
  paused: { label: '本地代理：已暂停', tone: 'neutral' },
  abnormal: { label: '本地代理：异常', tone: 'negative' },
}

function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`
}

export default function App(): ReactElement {
  const [minerId, setMinerId] = useState<string | null>(() => getSavedMinerId())

  if (!minerId) return <SetupScreen onSubmit={(id) => { saveMinerId(id); setMinerId(id) }} />

  return <Dashboard minerId={minerId} onReset={() => { clearMinerId(); setMinerId(null) }} />
}

function SetupScreen({ onSubmit }: { onSubmit: (id: string) => void }): ReactElement {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    const id = value.trim()
    if (!isValidMinerId(id)) {
      setError('Miner ID 格式无效:应为 48 位左右的 SS58 字符串(在 IOTA 应用 Miner 页面复制)')
      return
    }
    onSubmit(id)
  }

  return (
    <div className="app-shell">
      <div className="setup-shell">
        <div className="brand">
          <div className="brand-mark">I</div>
          <div>
            <p>IOTA TRAIN AT HOME</p>
            <h1>矿机监控</h1>
          </div>
        </div>
        <div className="setup-panel">
          <h2>添加 Miner ID</h2>
          <p>打开 IOTA 应用,复制 Miner 页面里的 Miner ID(公开 SS58 hotkey)。ID 仅保存在你的浏览器本地。</p>
          <input
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            placeholder="粘贴你的 Miner ID(SS58 hotkey)"
            spellCheck={false}
            autoFocus
          />
          {error && <div className="setup-error">{error}</div>}
          <button onClick={submit} disabled={!value.trim()}>开始监控</button>
        </div>
      </div>
    </div>
  )
}

function Dashboard({ minerId, onReset }: { minerId: string; onReset: () => void }): ReactElement {
  const { data, error, loading, refresh, countdown, fetchedAtMs } = useDashboard(minerId)
  const [tokenOpen, setTokenOpen] = useState(false)
  const now = Math.floor(Date.now() / 1000)
  const lookupStatus = LOOKUP_STATUS[data?.lookup.status ?? 'unknown']

  const trainingRows = useMemo(() => (data?.miner ? toTrainingRows(data.miner.epochRecords) : []), [data])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">I</div>
          <div>
            <p>IOTA TRAIN AT HOME</p>
            <h1>矿机监控</h1>
          </div>
        </div>
        <div className="header-actions">
          <span className={`connection ${error || data?.lookup.stale ? 'is-warning' : 'is-connected'}`}>
            <i />
            {loading ? '加载中…' : error ? '刷新失败 · 保留上次数据' : data?.lookup.stale ? '官方数据陈旧' : `更新 ${fetchedAtMs ? fmtTime(Math.floor(fetchedAtMs / 1000)) : '—'} · ${countdown}s 后刷新`}
          </span>
          <button className="refresh-btn" onClick={refresh} disabled={loading}>
            立即刷新
          </button>
          <button className="refresh-btn" onClick={onReset}>更换 Miner ID</button>
        </div>
      </header>

      <main className="page-content">
        {error && (
          <div className="error-box">
            <span>数据获取失败</span>
            <strong>{error}</strong>
          </div>
        )}
        {!data && loading && <div className="empty-state">正在读取矿机数据…</div>}
        {data && (() => {
          const onlineOfficial = data.lookup.status === 'contributing' || data.lookup.status === 'waiting'
          const onlineLocal = data.localReport !== null && !data.localReport.stale
            && ['training', 'waiting', 'queued', 'starting'].includes(data.localReport.status)
          const minerOnline = onlineOfficial || onlineLocal
          const minerPanel = (
            <section className="panel wide">
              <div className="panel-heading">
                <div>
                  <span>MINER STATUS / 矿机状态</span>
                  <h2>{data.miner?.name ?? 'Miner'}</h2>
                </div>
                <div className="panel-status">
                  <div className="panel-status-main" title="官方名单状态是最新采样，不是本机实时心跳">
                    <span className={`status-dot ${lookupStatus.tone}`} />
                    {lookupStatus.label}
                  </div>
                </div>
              </div>
              {data.lookup.warning && <div className="status-warning">{data.lookup.warning}</div>}
              <div className="metric-grid status-primary-grid">
                <div className="metric metric-primary">
                  <span>训练状态</span>
                  <strong className={data.miner?.training === true ? 'fresh' : data.miner?.training === false ? 'stale' : 'neutral'}>
                    {data.miner?.training === true ? '训练中' : data.miner?.training === false ? data.miner?.online === true ? '等待任务' : data.miner?.online === false ? '未参与' : '待确认' : '待确认'}
                  </strong>
                </div>
                <div className="metric metric-primary">
                  <span>吞吐量</span>
                  <strong className="strong">{fmtNum(data.miner?.throughput, 0)}</strong>
                </div>
                <div className="metric metric-primary">
                  <span>激活数</span>
                  <strong>{fmtNum(data.miner?.activations, 0)}</strong>
                </div>
                <div className="metric metric-primary">
                  <span>训练任务</span>
                  <strong>{data.miner?.runId ?? '—'}</strong>
                </div>
                <div className="metric metric-primary">
                  <span>昨日收益 (IOTA / USD)</span>
                  <strong className="strong">
                    {fmtIota(data.yesterdayEarned)} / {fmtUsd(data.yesterdayEarned, data.usdPerIota)}
                  </strong>
                </div>
              </div>
              <div className="status-details-grid">
                <div className="metric">
                  <span>负责分区</span>
                  <strong>{data.miner?.partitionLabel ?? '—'}</strong>
                </div>
                <div className="metric">
                  <span>官方采样时间</span>
                  <strong>{fmtAgo(data.lookup.sampleAt, now)}</strong>
                </div>
                <div className="metric">
                  <span>完整名单更新时间</span>
                  <strong>{fmtAgo(data.lookup.lastSuccessfulFetchAt, now)}</strong>
                </div>
                <div className="metric">
                  <span>任务名单覆盖</span>
                  <strong>{data.lookup.coverage.successful} / {data.lookup.coverage.total}{data.lookup.stale ? ' · 含缓存' : ''}</strong>
                </div>
                <div className="metric">
                  <span>最后有效贡献</span>
                  <strong className={data.miner?.lastContributionAt !== null && data.miner?.lastContributionAt !== undefined && now - data.miner.lastContributionAt > 3600 ? 'stale' : 'fresh'}>
                    {fmtContributionTime(data.miner?.lastContributionAt, now)}
                  </strong>
                </div>
              </div>
            </section>
          )

          const localPanel = (
            <section className="panel wide">
              <div className="panel-heading">
                <div>
                  <span>LOCAL AGENT / 本地状态</span>
                  <h2>本地代理</h2>
                </div>
                <div className="panel-status">
                  {data.localReport ? (
                    <div className="panel-status-main" title="来自本机 iota-agent 守护的实时上报,每三十秒一次">
                      <span className={`status-dot ${data.localReport.stale ? 'warning' : LOCAL_STATUS[data.localReport.status].tone}`} />
                      {data.localReport.stale ? '本地代理离线(超过 2.5 分钟无上报)' : LOCAL_STATUS[data.localReport.status].label}
                    </div>
                  ) : (
                    <button className="setup-agent-btn" onClick={() => setTokenOpen(true)}>配置本地管理 Agent</button>
                  )}
                </div>
              </div>
              {data.localReport ? (
                <>
                  <div className="metric-grid status-primary-grid">
                    <div className="metric metric-primary">
                      <span>队列位置</span>
                      <strong className="strong">{data.localReport.queuePosition !== null ? `第 ${data.localReport.queuePosition} 位` : '—'}</strong>
                    </div>
                    <div className="metric metric-primary">
                      <span>控制连接</span>
                      <strong className={data.localReport.controlConnected ? 'fresh' : 'stale'}>
                        {data.localReport.controlConnected ? '正常' : '未连接'}
                      </strong>
                    </div>
                    <div className="metric metric-primary">
                      <span>自动重启次数</span>
                      <strong>{fmtNum(data.localReport.restarts, 0)}</strong>
                    </div>
                    <div className="metric metric-primary">
                      <span>守护运行时长</span>
                      <strong>{fmtUptime(data.localReport.uptimeSec)}</strong>
                    </div>
                    <div className="metric metric-primary">
                      <span>上次上报</span>
                      <strong>{fmtAgo(data.localReport.reportedAtServer, now)}</strong>
                    </div>
                  </div>
                  <p className="status-note">守护状态：{data.localReport.description}</p>
                  <div className="status-details-grid">
                    <div className="metric">
                      <span>代理版本</span>
                      <strong>{data.localReport.agentVersion}</strong>
                    </div>
                    <div className="metric">
                      <span>操作系统</span>
                      <strong>{data.localReport.os === 'macos' ? 'macOS' : 'Linux'}</strong>
                    </div>
                    <div className="metric">
                      <span>更换令牌</span>
                      <strong><button className="link-btn" onClick={() => setTokenOpen(true)}>配置本地管理 Agent</button></strong>
                    </div>
                  </div>
                </>
              ) : (
                    <p className="empty-state">
                  未配置本地代理。在本机安装 iota-agent 并启用上报后,这里会显示矿机的实时本地状态(进程、队列、自动重启),与官方遥测互补。
                </p>
              )}
            </section>
          )

          return (
            <>
              {minerOnline ? minerPanel : localPanel}
              {minerOnline ? localPanel : minerPanel}

            <section className="panel wide">
              <div className="panel-heading">
                <div>
                  <span>TRAINING RECORDS / 训练记录</span>
                  <h2>训练记录(按 Epoch)</h2>
                </div>
              </div>
              {trainingRows.length === 0 ? (
                <p className="empty-state">暂无训练数据</p>
              ) : (
                <div className="table-wrap records-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Epoch</th>
                        <th>时间</th>
                        <th>Token 数</th>
                        <th>激活数</th>
                        <th>排名</th>
                        <th>贡献占比</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trainingRows.map((r) => (
                        <tr key={r.epoch}>
                          <td>#{r.epoch}</td>
                          <td>{fmtTime(r.ts)}</td>
                          <td>{fmtNum(r.tokens)}</td>
                          <td>{r.tokens > 0 ? fmtNum(r.tokens / 3200) : '—'}</td>
                          <td>{r.rank !== null && r.rank > 0 ? `${r.rank} / ${r.numHotkeys ?? '—'}` : '—'}</td>
                          <td>{fmtPct(r.contribution)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="panel wide">
              <div className="panel-heading">
                <div>
                  <span>NETWORK / 全网状态</span>
                  <h2>全网状态</h2>
                </div>
                <span>{data.runs.length} 个任务 · {data.runs[0]?.model ?? ''} {data.runs[0]?.modelSize ?? ''}</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>训练任务</th>
                      <th>档位</th>
                      <th>名额</th>
                      <th>官方在线</th>
                      <th>剩余名额</th>
                      <th>占用率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.runs.map((r) => (
                      <tr key={r.runId} className={r.runId === data.miner?.runId ? 'is-mine' : ''}>
                        <td>{r.runId}</td>
                        <td>{r.tier ?? '—'}</td>
                        <td>{fmtNum(r.maxMiners)}</td>
                        <td>{fmtNum(r.activeMiners)}</td>
                        <td className={r.slotsRemaining === 0 ? 'zero' : ''}>{r.slotsRemaining === 0 ? '已满' : fmtNum(r.slotsRemaining)}</td>
                        <td>{r.maxMiners > 0 ? `${Math.round((r.activeMiners / r.maxMiners) * 100)}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel wide">
              <div className="panel-heading">
                <div>
                  <span>EARNINGS / 收益记录</span>
                  <h2>收益记录</h2>
                </div>
                <span>USD 单价 ${data.usdPerIota?.toFixed(2) ?? '—'}</span>
              </div>
              <div className="metric-grid earnings-grid">
                <div className="metric">
                  <span>今日收益 (IOTA / USD)</span>
                  <strong className="strong">
                    {fmtIota(data.todayEarned)} / {fmtUsd(data.todayEarned, data.usdPerIota)}
                  </strong>
                </div>
                <div className="metric">
                  <span>累计收益 (IOTA / USD)</span>
                  <strong className="strong">
                    {fmtIota(data.totals.earned)} / {fmtUsd(data.totals.earned, data.usdPerIota)}
                  </strong>
                </div>
                <div className="metric">
                  <span>待结算 / 冻结</span>
                  <strong>
                    {fmtIota(data.totals.pending)} / {fmtIota(data.totals.frozen)}
                  </strong>
                </div>
              </div>
              <div className="table-wrap payments-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>日期</th>
                      <th>时间</th>
                      <th>金额 (IOTA)</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.payments.map((p, i) => (
                      <tr key={`${p.ts}-${i}`}>
                        <td>{fmtDate(p.ts)}</td>
                        <td>{fmtTime(p.ts).slice(-5)}</td>
                        <td className={p.amount > 0 ? 'positive' : 'zero'}>{fmtIota(p.amount)}</td>
                        <td>{p.status === 'settled' ? '已结算' : p.status === 'pending' ? '待结算' : p.status === 'frozen' ? '冻结中' : p.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            </>
          )
        })()}
      </main>

      <footer className="app-footer">
        <span>数据来源:Macrocosmos 公开接口 · 每分钟自动刷新</span>
      </footer>

      {tokenOpen && <TokenDialog minerId={minerId} onClose={() => setTokenOpen(false)} />}
    </div>
  )
}

function TokenDialog({ minerId, onClose }: { minerId: string; onClose: () => void }): ReactElement {
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copiedStep, setCopiedStep] = useState<number | null>(null)

  const generate = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await createToken(minerId)
      setToken(result.token)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const steps = token ? [
    { title: '1 · 全局安装(矿机上执行一次)', command: 'npm install -g iota-agent' },
    { title: '2 · 配对令牌', command: `iota-agent install && iota-agent report --enable --token ${token} --url ${location.origin} --miner ${minerId}` },
    { title: '3 · 优化启动(替代直接打开 IOTA 应用)', command: 'iota-agent start' },
  ] : []

  const copy = async (index: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedStep(index)
      setTimeout(() => setCopiedStep(null), 2000)
    } catch {
      // 剪贴板不可用时用户可手动选择文本
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>配置本地管理 Agent</h3>
          <button className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        {!token ? (
          <div className="modal-body">
            <p>iota-agent 安装在矿机本机,负责守护进程(异常自动重启)、优化启动,并经你授权后每 30 秒向本仪表盘上报脱敏状态。需要 macOS、Node 20+ 与已安装的官方 IOTA 应用。</p>
            <p className="modal-note">上报内容仅含:守护状态、队列位置、控制连接、重启次数、运行时长;不含主机名、路径、日志或任何密钥。令牌绑定当前 Miner ID,只显示一次,90 天自动过期。</p>
            {error && <div className="setup-error">{error}</div>}
            <button onClick={generate} disabled={busy}>{busy ? '生成中…' : '生成配对令牌'}</button>
          </div>
        ) : (
          <div className="modal-body">
            {steps.map((step, i) => (
              <div key={i} className="setup-step">
                <div className="setup-step-head">
                  <span>{step.title}</span>
                  <button onClick={() => copy(i, step.command)}>{copiedStep === i ? '已复制' : '复制'}</button>
                </div>
                <pre className="token-command">{step.command}</pre>
              </div>
            ))}
            <p className="modal-note">关闭窗口后令牌不再显示;如需更换,重新生成即可(旧令牌在过期前仍有效,可在矿机上执行 iota-agent report --disable 停用)。</p>
          </div>
        )}
      </div>
    </div>
  )
}
