import { useMemo, useState, type ReactElement } from 'react'
import { useDashboard, getSavedMinerId, saveMinerId, clearMinerId, isValidMinerId } from './api.js'
import { toTrainingRows } from './types.js'
import { fmtNum, fmtIota, fmtUsd, fmtTime, fmtDate, fmtPct, fmtAgo } from './format.js'

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
  const now = Math.floor(Date.now() / 1000)

  const trainingRows = useMemo(() => (data?.miner ? toTrainingRows(data.miner.trainingPoints) : []), [data])

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
          <span className="connection is-connected">
            <i />
            {loading ? '加载中…' : `${countdown}s 后刷新`}
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
        {data && (
          <>
            <section className="panel wide">
              <div className="panel-heading">
                <div>
                  <span>MINER STATUS / 矿机状态</span>
                  <h2>{data.miner?.name ?? 'Miner'}</h2>
                </div>
                <div className="panel-status">
                  <div className="panel-status-main">
                    <span className={`status-dot ${data.miner?.online ? 'positive' : 'negative'}`} />
                    {data.miner?.online ? '在线' : '离线'}
                  </div>
                  <span className="panel-last-seen">
                    更新 {fmtTime(data.fetchedAt)} · 下次刷新 {countdown}s
                  </span>
                </div>
              </div>
              <div className="metric-grid">
                <div className="metric">
                  <span>Miner ID</span>
                  <strong title={minerId}>{data.miner?.shortId ?? '—'}</strong>
                </div>
                <div className="metric">
                  <span>训练状态</span>
                  <strong className={data.miner?.training ? 'fresh' : 'stale'}>
                    {data.miner?.training ? '训练中' : data.miner?.online ? '等待任务' : '离线'}
                  </strong>
                </div>
                <div className="metric">
                  <span>吞吐量</span>
                  <strong className="strong">{fmtNum(data.miner?.throughput, 0)}</strong>
                </div>
                <div className="metric">
                  <span>激活数</span>
                  <strong>{fmtNum(data.miner?.activations, 0)}</strong>
                </div>
                <div className="metric">
                  <span>训练任务</span>
                  <strong>{data.miner?.runId ?? '—'}</strong>
                </div>
                <div className="metric">
                  <span>模型分区</span>
                  <strong>{data.miner?.uploadedPartition !== null && data.miner?.uploadedPartition !== undefined ? `${fmtNum(data.miner.uploadedPartition, 0)}%` : '—'}</strong>
                </div>
                <div className="metric">
                  <span>贡献占比</span>
                  <strong>{fmtPct(data.miner?.contributionPerc)}</strong>
                </div>
                <div className="metric">
                  <span>全网排名</span>
                  <strong>
                    {data.miner?.rank !== null && data.miner?.rank !== undefined ? `${data.miner.rank} / ${data.miner.numHotkeys ?? '—'}` : '—'}
                  </strong>
                </div>
                <div className="metric">
                  <span>最近采样</span>
                  <strong>{fmtAgo(data.miner?.latestSampleAt, now)}</strong>
                </div>
                <div className="metric">
                  <span>下次支付</span>
                  <strong>{fmtTime(data.nextPayoutAt)}</strong>
                </div>
              </div>
            </section>

            <section className="panel wide">
              <div className="panel-heading">
                <div>
                  <span>TRAINING RECORDS / 训练记录</span>
                  <h2>训练记录</h2>
                </div>
                <span>{trainingRows.length} 条非零记录</span>
              </div>
              {trainingRows.length === 0 ? (
                <p className="empty-state">暂无训练数据</p>
              ) : (
                <div className="table-wrap records-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>Token 数</th>
                        <th>贡献占比</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trainingRows.map((r) => (
                        <tr key={r.ts}>
                          <td>{fmtTime(r.ts)}</td>
                          <td>{fmtNum(r.tokens)}</td>
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
                <span>{data.runs.length} 个任务</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>训练任务</th>
                      <th>名额</th>
                      <th>在线矿机</th>
                      <th>剩余名额</th>
                      <th>占用率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.runs.map((r) => (
                      <tr key={r.runId} className={r.runId === data.miner?.runId ? 'is-mine' : ''}>
                        <td>{r.runId}</td>
                        <td>{fmtNum(r.maxMiners)}</td>
                        <td>{fmtNum(r.activeMiners)}</td>
                        <td className={r.slotsRemaining === 0 ? 'zero' : ''}>{fmtNum(r.slotsRemaining)}</td>
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
                        <td>{p.status === 'settled' ? '已结算' : p.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>

      <footer className="app-footer">
        <span>数据来源:Macrocosmos 公开接口 · 每分钟自动刷新</span>
        <span>{fetchedAtMs ? `最后刷新 ${fmtTime(Math.floor(fetchedAtMs / 1000))}` : ''}</span>
      </footer>
    </div>
  )
}
