import type { GuardianState } from './guardian.js'

export interface GuardianAlert { key: string; message: string }

// Report observations, not inferred causes. One local incident must not become
// both a generic health alarm and a P2P alarm with the same description.
export function guardianAlerts(state: GuardianState, now: number): GuardianAlert[] {
  if (!state.appPid) return [] // The process monitor reports exits separately.
  const suffix = '未自动重启。'
  if (state.status === 'abnormal') {
    return [{ key: `health:${state.sessionStartedAt}`, message: `IOTA 本地状态告警：${state.description}。${suffix}` }]
  }
  if (state.status === 'starting' || !state.minerAlive || !state.controlConnected) return []
  if (state.p2pAnomalyDetected && state.p2pAnomalyAt != null
    && now >= state.p2pAnomalyAt && now - state.p2pAnomalyAt <= 300) {
    return [{ key: `p2p:${state.sessionStartedAt}`, message: `IOTA P2P 日志提示：最近五分钟出现邻层无可路由 peer 的记录，尚未观察到后续训练；不能据此确认节点故障。${suffix}` }]
  }
  return []
}

// Two consecutive observations avoid alerts for a single transient health probe.
export function confirmedAlerts(current: GuardianAlert[], previousKeys: Set<string>): GuardianAlert[] {
  return current.filter((alert) => previousKeys.has(alert.key))
}
