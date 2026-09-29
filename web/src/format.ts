export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return n.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}

export function fmtIota(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 4 })
}

export function fmtUsd(iota: number | null | undefined, usdPerIota: number | null): string {
  if (iota === null || iota === undefined || !Number.isFinite(iota) || usdPerIota === null) return '—'
  const usd = iota * usdPerIota
  return `$${usd.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`
}

// 所有时间统一显示为北京时间(UTC+8),不随访问者时区变化
const BJ = 'Asia/Shanghai' as const

export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    timeZone: BJ,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}

export function fmtDate(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleDateString('zh-CN', { timeZone: BJ, month: '2-digit', day: '2-digit' })
}

export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const pct = n * 100
  if (pct > 0 && pct < 0.01) return '<0.01%'
  return `${pct.toLocaleString('zh-CN', { maximumFractionDigits: digits })}%`
}

export function fmtAgo(ts: number | null | undefined, now: number): string {
  if (!ts) return '—'
  const diff = Math.max(0, now - ts)
  if (diff < 60) return `${Math.round(diff)} 秒前`
  if (diff < 3600) return `${Math.round(diff / 60)} 分钟前`
  return `${Math.round(diff / 3600)} 小时前`
}
