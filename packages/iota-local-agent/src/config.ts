import { AGENT_DIR, CONFIG_PATH } from './paths.js'
import { atomicWriteJson, readJson } from './fsutil.js'

export interface AgentConfig {
  dashboardUrl: string
  token: string
  minerId: string
  reportEnabled: boolean
}

export async function loadConfig(): Promise<AgentConfig | null> {
  return readJson<AgentConfig>(CONFIG_PATH)
}

export async function saveConfig(config: AgentConfig): Promise<void> {
  await atomicWriteJson(CONFIG_PATH, config)
}

export async function updateConfig(patch: Partial<AgentConfig>): Promise<AgentConfig> {
  const current = await loadConfig()
  const next = { ...(current ?? { dashboardUrl: '', token: '', minerId: '', reportEnabled: false }), ...patch }
  await saveConfig(next)
  return next
}

export { AGENT_DIR }
