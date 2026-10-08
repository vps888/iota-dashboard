import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'

export const AGENT_VERSION = '0.1.0'

export interface ReportPayload {
  status: string
  description: string
  queuePosition: number | null
  controlConnected: boolean
  restarts: number
  uptimeSec: number
  reportedAt: number
  os: 'macos' | 'linux'
  agentVersion: string
}

export interface Reporter {
  enabled: boolean
  report(payload: ReportPayload): Promise<Response>
}

export function createReporter(config: { dashboardUrl: string; token: string; reportEnabled: boolean }): Reporter {
  return {
    enabled: config.reportEnabled && Boolean(config.dashboardUrl) && Boolean(config.token),
    async report(payload: ReportPayload): Promise<Response> {
      const url = `${config.dashboardUrl.replace(/\/$/, '')}/api/local-report`
      return fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      })
    },
  }
}

// 守护循环内使用:上报失败只计数,绝不让异常进入守护逻辑
export class ReportSink {
  private failures = 0

  constructor(
    private readonly reporter: Reporter | null,
    private readonly onPersistentFailure: (message: string) => Promise<void>,
  ) {}

  async submit(payload: ReportPayload): Promise<void> {
    if (!this.reporter?.enabled) return
    try {
      const res = await this.reporter.report(payload)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (this.failures >= 10) void this.onPersistentFailure('上报已恢复')
      this.failures = 0
    } catch (error) {
      this.failures += 1
      if (this.failures === 10) {
        void this.onPersistentFailure(`上报连续失败十次:${error instanceof Error ? error.message : String(error)};守护继续运行`)
      }
    }
  }
}

export async function readTokenFromArgOrFile(tokenArg: string | undefined, configToken: string): Promise<string> {
  if (tokenArg) return tokenArg
  if (tokenArg === undefined && configToken) return configToken
  if (tokenArg === undefined && !configToken && existsSync('/dev/stdin')) {
    return (await readFile('/dev/stdin', 'utf8')).trim()
  }
  return configToken
}

export function currentOs(): 'macos' | 'linux' {
  return platform() === 'darwin' ? 'macos' : 'linux'
}
