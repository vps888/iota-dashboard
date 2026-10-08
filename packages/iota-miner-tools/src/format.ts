import type { OfficialLookup, OfficialStatus } from './types.js'

const STATUS_LABEL: Record<OfficialStatus, string> = {
  contributing: '有训练贡献',
  waiting: '在线待任务',
  idle: '暂未参与',
  not_found: '未在完整任务名单中找到',
  unknown: '状态待确认',
  refresh_interrupted: '官方数据刷新中断',
}

export function formatOfficialLookup(minerId: string, lookup: OfficialLookup): string {
  const lines = [
    `Miner ID: ${minerId}`,
    `状态: ${STATUS_LABEL[lookup.status]}`,
  ]
  if (lookup.runId) lines.push(`训练任务: ${lookup.runId}`)
  if (lookup.miner?.sampleAt) lines.push(`官方采样: ${new Date(lookup.miner.sampleAt * 1000).toLocaleString()}`)
  if (lookup.lastSuccessfulFetchAt !== null) lines.push(`完整名单更新时间: ${new Date(lookup.lastSuccessfulFetchAt).toLocaleString()}`)
  lines.push(`名单覆盖: ${lookup.coverage.successful}/${lookup.coverage.total}`)
  if (lookup.stale) lines.push('提示: 当前结果来自上一次成功的官方数据。')
  if (lookup.warning) lines.push(`提示: ${lookup.warning}`)
  return lines.join('\n')
}
