import { useMemo, useState, type ReactElement } from 'react'
import {
  useDashboard, getSavedMinerId, saveMinerId, clearMinerId, isValidMinerId, createToken,
  useNoidDashboard, getSavedNoidAddress, saveNoidAddress, clearNoidAddress, isValidNoidAddressValue,
} from './api.js'
import { formatNoidAtomicUnits, type NoidPayment, type NoidWorkerSnapshot } from '../../packages/iota-miner-tools/src/noid.js'
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
  const [project, setProject] = useState<'iota' | 'noid'>('iota')
  const [minerId, setMinerId] = useState<string | null>(() => getSavedMinerId())
  const [noidAddress, setNoidAddress] = useState<string | null>(() => getSavedNoidAddress())

  return (
    <div className="app-shell">
      <header className="app-header">
        <Brand />
        <ProjectNavigation project={project} onSelect={setProject} />
      </header>
      <main className="page-content">
        {project === 'iota' ? (
          minerId ? (
            <Dashboard minerId={minerId} noidAddress={noidAddress} onReset={() => { clearMinerId(); setMinerId(null) }} />
          ) : (
            <SetupScreen onSubmit={(id) => { saveMinerId(id); setMinerId(id) }} />
          )
        ) : (
          noidAddress ? (
            <NoidPage address={noidAddress} onReset={() => { clearNoidAddress(); setNoidAddress(null) }} onGoIota={() => setProject('iota')} />
          ) : (
            <NoidSetupScreen onSubmit={(address) => { saveNoidAddress(address); setNoidAddress(address) }} />
          )
        )}
      </main>
      <footer className="app-footer">
        <span>mac-miner · IOTA 数据来自 Macrocosmos · NOID 数据来自 InnovLab</span>
        <span>本地调度快照需用户授权</span>
      </footer>
    </div>
  )
}

function ProjectNavigation({ project, onSelect }: { project: 'iota' | 'noid'; onSelect: (project: 'iota' | 'noid') => void }): ReactElement {
  return (
    <nav className="project-nav" role="tablist" aria-label="挖矿项目">
      <button type="button" role="tab" aria-selected={project === 'iota'} className={project === 'iota' ? 'is-selected' : ''} onClick={() => onSelect('iota')}>
        <span className="project-tab-mark iota-tab-mark" aria-hidden="true">I</span>
        <span><b>IOTA</b><small>Bittensor SN9</small></span>
      </button>
      <button type="button" role="tab" aria-selected={project === 'noid'} className={project === 'noid' ? 'is-selected' : ''} onClick={() => onSelect('noid')}>
        <span className="project-tab-mark noid-tab-mark" aria-hidden="true">N</span>
        <span><b>NOID</b><small>Parano1d</small></span>
      </button>
    </nav>
  )
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
      setError('Miner ID 格式无效，应为 SS58 hotkey。请从 IOTA 应用的 Miner 页面复制。')
      return
    }
    onSubmit(id)
  }

  return (
    <div className="setup-shell">
      <div className="setup-shell-inner">
        <div className="setup-intro">
          <span className="section-index">IOTA · Bittensor SN9</span>
          <h2>连接 IOTA miner</h2>
          <p>输入公开 Miner ID，查看训练、队列和结算数据。IOTA 与 NOID 使用不同身份，各自在对应项目页配置。</p>
        </div>
        <div className="setup-panel">
          <label htmlFor="iota-miner-id">Miner ID（SS58 hotkey）</label>
          <input
            id="iota-miner-id"
            value={value}
            onChange={(event) => { setValue(event.target.value); setError(null) }}
            onKeyDown={(event) => { if (event.key === 'Enter') submit() }}
            placeholder="粘贴 IOTA Miner ID"
            spellCheck={false}
            autoFocus
            aria-invalid={error !== null}
            aria-describedby={error ? 'iota-id-error' : undefined}
          />
          {error && <div id="iota-id-error" className="setup-error">{error}</div>}
          <p className="setup-note">Miner ID 是公开标识，会发送给 mac-miner 在线接口查询 IOTA 数据；不要输入钱包助记词或私钥。</p>
          <button onClick={submit} disabled={!value.trim()}>打开 IOTA 面板</button>
        </div>
      </div>
    </div>
  )
}

function NoidSetupScreen({ onSubmit }: { onSubmit: (address: string) => void }): ReactElement {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = () => {
    const address = value.trim()
    if (!isValidNoidAddressValue(address)) {
      setError('NOID 地址校验失败。请复制以 o1 开头的 Parano1d 主网收款地址。')
      return
    }
    onSubmit(address)
  }

  return (
    <div className="setup-shell noid-setup-shell">
      <div className="setup-shell-inner">
        <div className="setup-intro">
          <span className="section-index">NOID · Parano1d</span>
          <h2>连接 NOID 地址</h2>
          <p>输入独立的 NOID 主网收款地址，查询 InnovLab 矿池记录。这里不使用 IOTA Miner ID，也不需要私钥或助记词。</p>
        </div>
        <div className="setup-panel">
          <label htmlFor="noid-payout-address">NOID 收款地址</label>
          <input
            id="noid-payout-address"
            value={value}
            onChange={(event) => { setValue(event.target.value); setError(null) }}
            onKeyDown={(event) => { if (event.key === 'Enter') submit() }}
            placeholder="o1…"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            aria-invalid={error !== null}
            aria-describedby={error ? 'noid-address-error' : 'noid-address-note'}
          />
          {error && <div id="noid-address-error" className="setup-error">{error}</div>}
          <p id="noid-address-note" className="setup-note">该公开地址会发送至 mac-miner 在线接口并查询 InnovLab；只输入地址，不要输入钱包密钥。地址按独立身份保存。</p>
          <button onClick={submit} disabled={!value.trim()}>打开 NOID 面板</button>
        </div>
      </div>
    </div>
  )
}

function shortNoidAddress(address: string): string {
  return `${address.slice(0, 7)}…${address.slice(-7)}`
}

function noidPaymentStatus(status: string): string {
  if (status === 'confirmed') return '已确认'
  if (status === 'sent') return '已发送'
  if (status === 'prepared') return '待广播'
  return status
}

function NoidPage({ address, onReset, onGoIota }: { address: string; onReset: () => void; onGoIota: () => void }): ReactElement {
  const { data, error, loading, refresh, countdown, fetchedAtMs } = useNoidDashboard(address)
  const now = Math.floor(Date.now() / 1000)
  const scheduler = data?.localScheduler ?? null
  const local = scheduler?.snapshot ?? null
  const statusLabel = scheduler?.stale ? '本地上报已过期' : local ? NOID_STATUS[local.mode].label : scheduler ? 'miner-agent 未运行 NOID' : '尚未绑定 miner-agent'
  const statusTone = scheduler?.stale ? 'warning' : local ? NOID_STATUS[local.mode].tone : 'neutral'

  return (
    <div className="project-page noid-page">
      <div className="project-toolbar">
        <span className={`connection ${error || data?.stale ? 'is-warning' : 'is-connected'}`}>
          <i />
          {loading ? '查询中…' : error ? '查询失败 · 保留最近数据' : data?.stale ? '矿池数据为缓存' : `更新 ${fetchedAtMs ? fmtTime(Math.floor(fetchedAtMs / 1000)) : '—'} · ${countdown}s 后刷新`}
        </span>
        <div className="header-actions">
          <button className="refresh-btn" onClick={refresh} disabled={loading}>刷新 NOID</button>
          <button className="refresh-btn" onClick={onReset}>更换收款地址</button>
        </div>
      </div>
      <div className="project-content">
        {error && <div className="error-box"><span>矿池查询失败</span><strong>{error}</strong></div>}
        {!data && loading && <div className="empty-state">正在读取 InnovLab 矿池…</div>}
        {data && (
          <>
            {data.warning && <div className="status-warning">{data.warning}</div>}
            <section className="noid-overview">
              <div className="noid-overview-head">
                <div className="noid-address-title">
                  <span className="noid-glyph" aria-hidden="true">N</span>
                  <div>
                    <span className="section-index">Parano1d · InnovLab</span>
                    <h2>NOID 矿池概览</h2>
                    <code className="noid-address-id" title={address}>{shortNoidAddress(address)}</code>
                  </div>
                </div>
                <div className={`mode-flag ${data.found ? 'positive' : 'warning'}`}>
                  {data.found ? `${fmtNum(data.workersOnline)} 个在线 Worker` : '矿池暂未记录该地址'}
                </div>
              </div>
              {!data.found && <p className="noid-not-found">地址暂未出现在矿池统计中；确认矿工已连接正确的 NOID 主网矿池后再刷新。</p>}
              <div className="noid-pool-stats">
                <div className="pool-rate-primary">
                  <span>矿池记录算力</span>
                  <strong>{fmtHashrate(data.hashrateHps)}</strong>
                  <small>统计口径：矿池接受工作量</small>
                </div>
                <div className="pool-stat">
                  <span>接受份额 · 10 分钟</span>
                  <strong>{fmtNum(data.shares.accepted10m)}</strong>
                </div>
                <div className="pool-stat">
                  <span>接受份额 · 1 小时</span>
                  <strong>{fmtNum(data.shares.accepted1h)}</strong>
                </div>
                <div className="pool-stat">
                  <span>接受份额 · 24 小时</span>
                  <strong>{fmtNum(data.shares.accepted24h)}</strong>
                </div>
              </div>
              <div className="noid-balance-grid">
                <div><span>待结算</span><strong>{formatNoidAtomicUnits(data.balanceAtomic.pending)} NOID</strong></div>
                <div><span>已确认</span><strong>{formatNoidAtomicUnits(data.balanceAtomic.confirmed)} NOID</strong></div>
                <div><span>累计支付</span><strong>{formatNoidAtomicUnits(data.balanceAtomic.paid)} NOID</strong></div>
                <div><span>最低支付门槛</span><strong>{formatNoidAtomicUnits(data.payoutAtomic.minimum)} NOID</strong></div>
              </div>
            </section>

            <div className="noid-detail-grid">
              <section className="panel noid-workers-panel">
                <div className="panel-heading">
                  <div><span>本机矿工</span><h2>Worker 状态</h2></div>
                  <span>{data.workers.length} 个 Worker</span>
                </div>
                {data.workers.length === 0 ? (
                  <p className="empty-state">暂无 Worker 记录</p>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Worker</th><th>状态</th><th>算力</th><th>接受</th><th>拒绝 / 过期</th></tr></thead>
                      <tbody>{data.workers.map((worker, index) => (
                        <tr key={index}>
                          <td>Worker {index + 1}</td>
                          <td>{worker.online === true ? '在线' : worker.online === false ? '离线' : '—'}</td>
                          <td>{fmtHashrate(worker.hashrateHps)}</td>
                          <td>{fmtNum(worker.accepted)}</td>
                          <td>{fmtNum(worker.rejected)} / {fmtNum(worker.stale)}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="panel noid-scheduler-panel">
                <div className="panel-heading">
                  <div><span>mac-miner 本机调度</span><h2>负载状态</h2></div>
                  <span className={`mode-flag ${statusTone}`}>{statusLabel}</span>
                </div>
                {local ? (
                  <div className={`local-noid-snapshot ${scheduler?.stale ? 'is-stale' : ''}`}>
                    <div className="local-duty-grid">
                      <div><span>CPU 目标占空比</span><strong>{local.cpuDuty === null ? '—' : `${local.cpuDuty}%`}</strong><small>{fmtHashrate(local.cpuRate)}</small></div>
                      <div><span>GPU 目标占空比</span><strong>{local.gpuDuty === null ? '—' : `${local.gpuDuty}%`}</strong><small>{fmtHashrate(local.gpuRate)}</small></div>
                    </div>
                    <div className="share-strip">
                      <span>本次接受 <b>{fmtNum(local.accepted)}</b></span>
                      <span>拒绝 <b>{fmtNum(local.rejected)}</b></span>
                      <span>过期 <b>{fmtNum(local.stale)}</b></span>
                    </div>
                    <p className="telemetry-note">最近上报 {fmtAgo(scheduler?.reportedAtServer ?? null, now)}。占空比是计算目标，不代表功耗。</p>
                  </div>
                ) : (
                  <div className="agent-empty">
                    <span className="empty-mark">⌁</span>
                    <p>{scheduler ? 'Agent 已绑定，但没有可显示的 NOID 调度快照。' : '本机调度尚未绑定到此地址。请在 IOTA 项目页启用上报并将该 NOID 地址加入配对。'}</p>
                    {!scheduler && <button className="link-btn" onClick={onGoIota}>去 IOTA 项目页配对 miner-agent</button>}
                  </div>
                )}
              </section>
            </div>

            <section className="panel noid-payments-panel">
              <div className="panel-heading">
                <div><span>链上转账 · 矿池记录</span><h2>支付记录</h2></div>
                <span>未将预估产出计入收益</span>
              </div>
              {data.payments.length === 0 ? (
                <p className="empty-state">暂无矿池支付记录</p>
              ) : (
                <div className="table-wrap payments-wrap">
                  <table>
                    <thead><tr><th>时间</th><th>金额</th><th>状态</th><th>交易 ID</th></tr></thead>
                    <tbody>{data.payments.map((payment, index) => (
                      <tr key={`${payment.txid ?? 'pending'}-${payment.createdAt ?? index}`}>
                        <td>{fmtTime(payment.createdAt)}</td>
                        <td className="positive">{formatNoidAtomicUnits(payment.amountAtomic)} NOID</td>
                        <td>{noidPaymentStatus(payment.status)}</td>
                        <td><code className="txid" title={payment.txid ?? ''}>{payment.txid ? `${payment.txid.slice(0, 10)}…${payment.txid.slice(-8)}` : '待生成'}</code></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}

function Dashboard({ minerId, noidAddress, onReset }: { minerId: string; noidAddress: string | null; onReset: () => void }): ReactElement {
  const { data, error, loading, refresh, countdown, fetchedAtMs } = useDashboard(minerId)
  const [tokenOpen, setTokenOpen] = useState(false)
  const now = Math.floor(Date.now() / 1000)
  const lookupStatus = LOOKUP_STATUS[data?.lookup.status ?? 'unknown']

  const trainingRows = useMemo(() => (data?.miner ? toTrainingRows(data.miner.epochRecords) : []), [data])

  return (
    <>
      <div className="project-toolbar">
        <span className={`connection ${error || data?.lookup.stale ? 'is-warning' : 'is-connected'}`}>
          <i />
          {loading ? '加载中…' : error ? '刷新失败 · 保留上次数据' : data?.lookup.stale ? '官方数据陈旧' : `更新 ${fetchedAtMs ? fmtTime(Math.floor(fetchedAtMs / 1000)) : '—'} · ${countdown}s 后刷新`}
        </span>
        <button className="refresh-btn" onClick={refresh} disabled={loading}>刷新 IOTA</button>
        <button className="refresh-btn" onClick={onReset}>更换 Miner ID</button>
      </div>
      <div className="project-content">
        {error && (
          <div className="error-box">
            <span>数据获取失败</span>
            <strong>{error}</strong>
          </div>
        )}
        {!data && loading && <div className="empty-state">正在读取 IOTA 数据…</div>}
        {data && (() => {
          const onlineOfficial = !data.lookup.stale && (data.lookup.status === 'contributing' || data.lookup.status === 'waiting')
          const onlineLocal = data.localReport !== null && !data.localReport.stale
            && ['training', 'waiting', 'queued', 'starting'].includes(data.localReport.status)
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
                    <span className="lane-kicker">miner-agent · 本机调度</span>
                    <h3>本机调度</h3>
                  </div>
                </div>
                <div className="panel-status">
                  {data.localReport ? (
                    <div className="panel-status-main" title="来自本机 miner-agent 的 opt-in 上报">
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
                      <span>miner-agent 版本</span>
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
                </>
              ) : (
                <div className="agent-empty">
                  <span className="empty-mark">⌁</span>
                  <p>连接 miner-agent 后，查看 IOTA 队列与守护状态。上报默认关闭，只发送你授权的数据。</p>
                </div>
              )}
            </section>
          )

          return (
            <>
              <section className={`machine-overview ${minerOnline ? 'is-active' : 'is-idle'}`}>
                <div className="machine-overview-head">
                  <div>
                    <span className="section-index">IOTA · Bittensor SN9</span>
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
      </div>
      {tokenOpen && <TokenDialog minerId={minerId} noidAddress={noidAddress} onClose={() => setTokenOpen(false)} />}
    </>
  )
}
function TokenDialog({ minerId, noidAddress, onClose }: { minerId: string; noidAddress: string | null; onClose: () => void }): ReactElement {
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copiedStep, setCopiedStep] = useState<number | null>(null)

  const generate = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await createToken(minerId, noidAddress ?? undefined)
      setToken(result.token)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const steps = token ? [
    { title: '安装 miner-agent', command: 'npm install -g miner-agent', note: '可选启用 NOID 调度；需安装 mac-miner 定制版 NOID Miner。' },
    { title: '启用登录后守护', command: 'miner-agent install', note: '每 30 秒读取 IOTA 状态；不会改动钱包。' },
    { title: '配对并启用在线上报', command: `miner-agent report --enable --token ${token} --url ${location.origin} --miner ${minerId}`, note: noidAddress ? `此令牌同时绑定 NOID 地址 ${noidAddress.slice(0, 7)}…${noidAddress.slice(-6)}；NOID 本地调度状态会单独显示在 NOID 页面。` : '尚未设置 NOID 地址；以后补充地址后需重新配对，才能关联 NOID 本地调度状态。' },
    { title: '启用 NOID 调度（可选）', command: 'miner-agent noid enable', note: '需先安装 mac-miner 定制版 NOID Miner.app，并退出旧版矿工。' },
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
          <h3>连接 miner-agent</h3>
          <button className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        {!token ? (
          <div className="modal-body">
            <p>miner-agent 运行在矿机本机，观察 IOTA 状态并按策略调度 NOID。在线上报需要单独授权；两个项目使用独立页面和身份。</p>
            <p className="modal-note">上报字段包含 IOTA 队列/控制状态；绑定 NOID 地址时，另上报 NOID 调度模式、CPU/GPU 目标占空比、算力与份额计数。不含私钥、助记词、能耗或收益。绑定后，这两个公开标识会关联；知道对应 Miner ID 或 NOID 地址的人可能看到该身份对应的本地状态。令牌仅用于本机上报，只显示一次，90 天过期。</p>
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
            <p className="modal-note">关闭窗口后令牌不再显示;如需更换,重新生成即可(旧令牌在过期前仍有效,可在矿机上执行 miner-agent report --disable 停用)。</p>
          </div>
        )}
      </div>
    </div>
  )
}
