import { useMemo, useState, type ReactElement } from 'react'
import { useDashboard, getSavedMinerId, saveMinerId, clearMinerId, isValidMinerId, createToken } from './api.js'
import { toTrainingRows } from './types.js'
import { fmtNum, fmtIota, fmtUsd, fmtTime, fmtDate, fmtPct, fmtAgo, fmtContributionTime } from './format.js'
import type { OfficialStatus } from '../../packages/iota-miner-tools/src/types.js'
import type { LocalReport, LocalNoidReport } from './api.js'

const LOOKUP_STATUS: Record<OfficialStatus, { label: string; tone: string }> = {
  contributing: { label: '官方采样：有训练贡献', tone: 'positive' },
  waiting: { label: '官方采样：在线待任务', tone: 'positive' },
  idle: { label: '官方采样：暂未参与', tone: 'warning' },
  not_found: { label: '完整名单中未找到', tone: 'negative' },
  unknown: { label: '状态待确认', tone: 'neutral' },
  refresh_interrupted: { label: '官方数据刷新中断', tone: 'neutral' },
}

const LOCAL_STATUS: Record<LocalReport['status'], { label: string; tone: string }> = {
  training: { label: '本机训练中', tone: 'positive' },
  waiting: { label: '本机待任务', tone: 'positive' },
  queued: { label: '本机排队中', tone: 'warning' },
  starting: { label: '本机启动中', tone: 'warning' },
  paused: { label: '本机已暂停', tone: 'neutral' },
  abnormal: { label: '本机异常', tone: 'negative' },
}

const NOID_STATUS: Record<LocalNoidReport['mode'], { label: string; tone: string }> = {
  training: { label: 'IOTA 训练 · NOID 低负载', tone: 'positive' },
  default: { label: 'NOID 默认负载', tone: 'warning' },
  disabled: { label: '未接管', tone: 'neutral' },
  unmanaged: { label: '手动矿工', tone: 'warning' },
  error: { label: '控制异常', tone: 'negative' },
}

function fmtHashrate(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  if (value >= 1_000_000) return `${fmtNum(value / 1_000_000, 2)} MH/s`
  if (value >= 1_000) return `${fmtNum(value / 1_000, 1)} kH/s`
  return `${fmtNum(value, 0)} H/s`
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

function Brand(): ReactElement {
  return (
    <div className="brand">
      <div className="brand-mark" aria-hidden="true"><span /><span /><i /></div>
      <div className="brand-copy">
        <p>本机算力调度与监控</p>
        <h1>mac-miner</h1>
      </div>
    </div>
  )
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
        <div className="setup-shell-inner">
          <Brand />
          <div className="setup-panel">
          <span className="section-index">连接矿机</span>
          <h2>添加 IOTA Miner ID</h2>
          <p>粘贴 IOTA Train at Home 的公开 Miner ID。它会保存在当前浏览器，并用于向 mac-miner 在线接口查询公开 IOTA 数据；无需提供钱包密钥。</p>
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
        <Brand />
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
          const onlineOfficial = !data.lookup.stale && (data.lookup.status === 'contributing' || data.lookup.status === 'waiting')
          const onlineLocal = data.localReport !== null && !data.localReport.stale
            && (['training', 'waiting', 'queued', 'starting'].includes(data.localReport.status) || data.localReport.noid?.running === true)
          const minerOnline = onlineOfficial || onlineLocal
          const minerPanel = (
            <section className="status-lane iota-lane">
              <div className="lane-heading">
                <div className="lane-identity">
                  <span className="network-mark" aria-hidden="true">I</span>
                  <div>
                    <span className="lane-kicker">IOTA · Bittensor SN9</span>
                    <h3>{data.miner?.name ?? 'IOTA Miner'}</h3>
                  </div>
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
                  <span>昨日收益</span>
                  <strong className="strong">{fmtIota(data.yesterdayEarned)} IOTA <small>{fmtUsd(data.yesterdayEarned, data.usdPerIota)}</small></strong>
                </div>
              </div>
              <div className="status-details-grid">
                <div className="metric">
                  <span>训练任务</span>
                  <strong>{data.miner?.runId ?? '—'}</strong>
                </div>
                <div className="metric">
                  <span>负责分区</span>
                  <strong>{data.miner?.partitionLabel ?? '—'}</strong>
                </div>
                <div className="metric">
                  <span>官方采样</span>
                  <strong>{fmtAgo(data.lookup.sampleAt, now)}</strong>
                </div>
                <div className="metric">
                  <span>名单覆盖</span>
                  <strong>{data.lookup.coverage.successful} / {data.lookup.coverage.total}{data.lookup.stale ? ' · 缓存' : ''}</strong>
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
            <section className="status-lane local-lane">
              <div className="lane-heading">
                <div className="lane-identity">
                  <span className="network-mark local-mark" aria-hidden="true">m</span>
                  <div>
                    <span className="lane-kicker">mac-miner · 本机 Agent</span>
                    <h3>本机调度</h3>
                  </div>
                </div>
                <div className="panel-status">
                  {data.localReport ? (
                    <div className="panel-status-main" title="来自本机 iota-agent 的 opt-in 上报">
                      <span className={`status-dot ${data.localReport.stale ? 'warning' : LOCAL_STATUS[data.localReport.status].tone}`} />
                      {data.localReport.stale ? '上报已过期' : LOCAL_STATUS[data.localReport.status].label}
                    </div>
                  ) : (
                    <button className="setup-agent-btn" onClick={() => setTokenOpen(true)}>连接本机</button>
                  )}
                </div>
              </div>
              {data.localReport ? (
                <>
                  <div className="metric-grid status-primary-grid local-primary-grid">
                    <div className="metric metric-primary">
                      <span>IOTA 队列</span>
                      <strong className="strong">{data.localReport.queuePosition !== null ? `第 ${data.localReport.queuePosition} 位` : '—'}</strong>
                    </div>
                    <div className="metric metric-primary">
                      <span>控制连接</span>
                      <strong className={data.localReport.controlConnected ? 'fresh' : 'stale'}>
                        {data.localReport.controlConnected ? '正常' : '未连接'}
                      </strong>
                    </div>
                    <div className="metric metric-primary">
                      <span>自动恢复</span>
                      <strong>{fmtNum(data.localReport.restarts, 0)} 次</strong>
                    </div>
                    <div className="metric metric-primary">
                      <span>代理运行</span>
                      <strong>{fmtUptime(data.localReport.uptimeSec)}</strong>
                    </div>
                  </div>
                  <div className="status-details-grid local-details-grid">
                    <div className="metric">
                      <span>最后上报</span>
                      <strong>{fmtAgo(data.localReport.reportedAtServer, now)}</strong>
                    </div>
                    <div className="metric">
                      <span>Agent 版本</span>
                      <strong>{data.localReport.agentVersion}</strong>
                    </div>
                    <div className="metric">
                      <span>系统</span>
                      <strong>{data.localReport.os === 'macos' ? 'macOS' : 'Linux'}</strong>
                    </div>
                    <div className="metric">
                      <span>配对设置</span>
                      <strong><button className="link-btn" onClick={() => setTokenOpen(true)}>管理上报</button></strong>
                    </div>
                  </div>
                  {data.localReport.noid ? (
                    <div className={`noid-module ${data.localReport.stale ? 'is-stale' : ''}`}>
                      <div className="noid-module-head">
                        <div className="noid-module-name">
                          <span className="noid-glyph" aria-hidden="true">N</span>
                          <div><span className="module-kicker">Parano1d · NOID</span><h4>挖矿状态</h4></div>
                        </div>
                        <span className={`mode-flag ${NOID_STATUS[data.localReport.noid.mode].tone}`}>
                          {NOID_STATUS[data.localReport.noid.mode].label}
                        </span>
                      </div>
                      <div className="noid-rate-grid">
                        <div className="noid-rate">
                          <span>CPU 算力</span>
                          <strong>{fmtHashrate(data.localReport.noid.cpuRate)}</strong>
                          <small>占空比目标 <b>{data.localReport.noid.cpuDuty === null ? '—' : `${data.localReport.noid.cpuDuty}%`}</b></small>
                        </div>
                        <div className="noid-rate">
                          <span>GPU 算力</span>
                          <strong>{fmtHashrate(data.localReport.noid.gpuRate)}</strong>
                          <small>占空比目标 <b>{data.localReport.noid.gpuDuty === null ? '—' : `${data.localReport.noid.gpuDuty}%`}</b></small>
                        </div>
                      </div>
                      <div className="share-strip">
                        <span>本次接受 <b>{fmtNum(data.localReport.noid.accepted)}</b></span>
                        <span>拒绝 <b>{fmtNum(data.localReport.noid.rejected)}</b></span>
                        <span>过期 <b>{fmtNum(data.localReport.noid.stale)}</b></span>
                      </div>
                      <p className="telemetry-note">占空比是计算目标，不代表功耗或整机耗电。</p>
                    </div>
                  ) : (
                    <div className="noid-empty">
                      <span>NOID 状态尚未上报</span>
                      <p>启用 mac-miner 调度并授权本地状态上报后，这里会显示算力与接受份额；不会采集钱包或能耗数据。</p>
                    </div>
                  )}
                </>
              ) : (
                <div className="agent-empty">
                  <span className="empty-mark">⌁</span>
                  <p>连接本机 Agent 后，查看 IOTA 队列与 NOID 负载。上报默认关闭，只发送你授权的状态数据。</p>
                </div>
              )}
            </section>
          )

          return (
            <>
              <section className={`machine-overview ${minerOnline ? 'is-active' : 'is-idle'}`}>
                <div className="machine-overview-head">
                  <div>
                    <span className="section-index">机况 · IOTA / NOID</span>
                    <h2>运行概览</h2>
                  </div>
                  <div className="miner-id-readout">
                    <span>Miner ID</span>
                    <code>{data.miner?.shortId ?? `${minerId.slice(0, 6)}…${minerId.slice(-6)}`}</code>
                  </div>
                </div>
                <div className="machine-lanes">
                  {minerPanel}
                  {localPanel}
                </div>
              </section>

              <div className="history-grid">
                <section className="panel history-panel training-panel">
              <div className="panel-heading">
                <div>
                  <span>IOTA · 训练</span>
                  <h2>训练记录</h2>
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

              <section className="panel history-panel network-panel">
                <div className="panel-heading">
                  <div>
                    <span>网络容量 · 训练任务</span>
                    <h2>任务名额</h2>
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

              <section className="panel history-panel earnings-panel">
                <div className="panel-heading">
                  <div>
                    <span>结算记录</span>
                    <h2>收益与结算</h2>
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
              </div>
            </>
          )
        })()}
      </main>

      <footer className="app-footer">
        <span>mac-miner · IOTA 数据来自 Macrocosmos · 本地状态由你授权上报</span>
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
    { title: '安装本地管理程序', command: 'npm install -g iota-agent', note: '当前 CLI 名称仍是 iota-agent；NOID 联动需要包含此功能的 mac-miner 版本。' },
    { title: '启用登录后守护', command: 'iota-agent install', note: '每 30 秒读取 IOTA 状态；不会改动钱包。' },
    { title: '配对并启用在线上报', command: `iota-agent report --enable --token ${token} --url ${location.origin} --miner ${minerId}`, note: '只上报你授权的状态快照；不包含钱包或 NOID 收益、电耗。' },
    { title: '启用 IOTA → NOID 调度（可选）', command: 'iota-agent noid enable', note: '需先安装 mac-miner 定制版 NOID Miner.app，并退出旧版矿工。' },
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
          <h3>连接本机 mac-miner Agent</h3>
          <button className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        {!token ? (
          <div className="modal-body">
            <p>mac-miner Agent 运行在矿机本机，观察 IOTA 状态并按策略调度 NOID。在线上报需要单独授权；没有 Agent 快照时，页面仍只显示官方 IOTA 数据。</p>
            <p className="modal-note">上报字段包含队列、控制状态、调度模式、CPU/GPU 占空比目标、算力与份额计数；不含钱包、私钥、主机名、文件路径、日志、能耗或收益。上报状态会显示在该公开 Miner ID 的监控页，知道此 ID 的人都可能查看。令牌仅用于本机上报，绑定当前 Miner ID，只显示一次，90 天过期。</p>
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
                {step.note && <p className="setup-step-note">{step.note}</p>}
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
