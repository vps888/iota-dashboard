import { execFile } from 'node:child_process'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_DIR, LAUNCH_AGENT_LABEL, LAUNCH_AGENT_PLIST } from './paths.js'

const FEISHU_LABEL = 'com.local.miner-agent-feishu'
const FEISHU_PLIST = join(dirname(LAUNCH_AGENT_PLIST), `${FEISHU_LABEL}.plist`)
function cliPath(): string { return join(fileURLToPath(new URL('.', import.meta.url)), 'cli.js') }
function uid(): number {
  const value = process.getuid?.()
  if (value === undefined) throw new Error('LaunchAgent 仅支持 macOS')
  return value
}
function command(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => execFile(file, args, (error, stdout, stderr) => resolve({ code: error ? Number(error.code) || 1 : 0, stdout: stdout ?? '', stderr: stderr ?? '' })))
}
async function install(label: string, path: string, argv: string[], log: string): Promise<void> {
  const user = uid()
  await mkdir(dirname(path), { recursive: true })
  await mkdir(AGENT_DIR, { recursive: true })
  const args = [process.execPath, cliPath(), ...argv]
  const xml = args.map((value) => `<string>${value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}</string>`).join('')
  const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${xml}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>ProcessType</key><string>Background</string><key>WorkingDirectory</key><string>${AGENT_DIR}</string><key>StandardOutPath</key><string>${log}</string><key>StandardErrorPath</key><string>${log}</string></dict></plist>`
  await writeFile(path, plist)
  await chmod(path, 0o644)
  await command('launchctl', ['bootout', `gui/${user}/${label}`])
  const result = await command('launchctl', ['bootstrap', `gui/${user}`, path])
  if (result.code !== 0 && !/service already loaded|already loaded/i.test(result.stderr)) throw new Error(`LaunchAgent 启动失败：${result.stderr.trim()}`)
}
async function stop(label: string, path: string): Promise<void> {
  const user = uid()
  const result = await command('launchctl', ['bootout', `gui/${user}/${label}`])
  if (result.code !== 0 && !/Could not find service|No such process/i.test(result.stderr)) throw new Error(`停止 LaunchAgent 失败：${result.stderr.trim()}`)
  await rm(path, { force: true })
}
export async function installLaunchAgent(): Promise<void> { await install(LAUNCH_AGENT_LABEL, LAUNCH_AGENT_PLIST, ['run'], join(AGENT_DIR, 'agent-run.log')) }
export async function startFeishuLaunchAgent(): Promise<void> {
  const result = await command('launchctl', ['kickstart', `gui/${uid()}/${FEISHU_LABEL}`])
  if (result.code !== 0) throw new Error(`飞书机器人启动失败：${result.stderr.trim()}`)
}
export async function stopLaunchAgent(): Promise<void> { await stop(LAUNCH_AGENT_LABEL, LAUNCH_AGENT_PLIST) }
export async function installFeishuLaunchAgent(): Promise<void> { await install(FEISHU_LABEL, FEISHU_PLIST, ['feishu', 'service'], join(AGENT_DIR, 'feishu.log')) }
export async function stopFeishuLaunchAgent(): Promise<void> { await stop(FEISHU_LABEL, FEISHU_PLIST) }
export async function launchAgentStatus(): Promise<{ guardian: boolean; feishu: boolean }> {
  uid()
  const result = await command('launchctl', ['list'])
  const lines = result.stdout + result.stderr + '\n'
  return { guardian: lines.includes(LAUNCH_AGENT_LABEL), feishu: lines.includes(FEISHU_LABEL) }
}
