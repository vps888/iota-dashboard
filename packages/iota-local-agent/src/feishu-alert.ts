import { Client } from '@larksuiteoapi/node-sdk'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const FEISHU_CONFIG_PATH = join(homedir(), '.miner-agent', 'feishu.json')
const AGENT_CONFIG_PATH = join(homedir(), '.miner-agent', 'config.json')
export type AlertConfig = { appId: string; appSecret: string; chatId: string; allowedOpenIds: string[] }
export type AlertDestination = { chatId: string; enabled?: boolean }
export type AgentConfig = { alertDestinations?: AlertDestination[] }

export async function sendAgentAlert(config: AlertConfig, text: string): Promise<void> {
  const client = new Client({ appId: config.appId, appSecret: config.appSecret, domain: 'https://open.feishu.cn' })
  await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: config.chatId, msg_type: 'text', content: JSON.stringify({ text }) },
  })
}

export async function fanoutAgentAlert(config: AlertConfig, agentConfig: AgentConfig, text: string): Promise<void> {
  const destinations = new Set([config.chatId, ...(agentConfig.alertDestinations ?? []).filter((d) => d.enabled !== false).map((d) => d.chatId)])
  const results = await Promise.allSettled([...destinations].map((chatId) => sendAgentAlert({ ...config, chatId }, text)))
  const failures = results.flatMap((result, index) => result.status === 'rejected' ? [
    `${[...destinations][index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
  ] : [])
  if (failures.length) throw new Error(`告警消息发送失败：${failures.join('; ')}`)
}

export async function configuredAlertTarget(): Promise<AlertConfig | null> {
  try {
    const config = JSON.parse(await readFile(FEISHU_CONFIG_PATH, 'utf8')) as Partial<AlertConfig>
    if (typeof config.appId !== 'string' || typeof config.appSecret !== 'string' || typeof config.chatId !== 'string' || !Array.isArray(config.allowedOpenIds) || config.allowedOpenIds.length === 0) return null
    return config as AlertConfig
  } catch { return null }
}
export async function loadAgentConfig(): Promise<AgentConfig> {
  try { return JSON.parse(await readFile(AGENT_CONFIG_PATH, 'utf8')) as AgentConfig } catch { return {} }
}
