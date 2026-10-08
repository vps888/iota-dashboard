import { execFile } from 'node:child_process'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_DIR, LAUNCH_AGENT_LABEL, LAUNCH_AGENT_PLIST } from './paths.js'

function cliPath(): string {
  const here = fileURLToPath(new URL('.', import.meta.url))
  return join(here, 'cli.js')
}

function execFileAsync(file: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, (error, _stdout, stderr) => {
      resolve({ code: error ? (error.code as number ?? 1) : 0, stderr: stderr ?? '' })
    })
  })
}

function uid(): number {
  const value = process.getuid?.()
  if (value === undefined) throw new Error('当前平台不支持 launchctl(仅 macOS)')
  return value
}

export async function installLaunchAgent(): Promise<void> {
  const uidValue = uid()
  await mkdir(dirname(LAUNCH_AGENT_PLIST), { recursive: true })
  await mkdir(AGENT_DIR, { recursive: true })
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${cliPath()}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
  <key>WorkingDirectory</key><string>${AGENT_DIR}</string>
  <key>StandardOutPath</key><string>${AGENT_DIR}/agent-run.log</string>
  <key>StandardErrorPath</key><string>${AGENT_DIR}/agent-run.log</string>
</dict>
</plist>
`
  await writeFile(LAUNCH_AGENT_PLIST, plist)
  await chmod(LAUNCH_AGENT_PLIST, 0o644)
  await execFileAsync('launchctl', ['bootout', `gui/${uidValue}/${LAUNCH_AGENT_LABEL}`])
  const result = await execFileAsync('launchctl', ['bootstrap', `gui/${uidValue}`, LAUNCH_AGENT_PLIST])
  if (result.code !== 0) {
    throw new Error(`守护未能启用(launchctl bootstrap 失败):${result.stderr.trim()}`)
  }
}

export async function uninstallLaunchAgent(): Promise<void> {
  const uidValue = uid()
  await execFileAsync('launchctl', ['bootout', `gui/${uidValue}/${LAUNCH_AGENT_LABEL}`])
  await rm(LAUNCH_AGENT_PLIST, { force: true })
}
