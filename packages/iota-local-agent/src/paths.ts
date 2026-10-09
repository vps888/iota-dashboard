import { homedir } from 'node:os'
import { join } from 'node:path'

export const AGENT_DIR = join(homedir(), '.miner-agent')
export const CONFIG_PATH = join(AGENT_DIR, 'config.json')
export const STATE_PATH = join(AGENT_DIR, 'state.json')
export const EVENTS_PATH = join(AGENT_DIR, 'guardian.log')
export const LOCK_PATH = join(AGENT_DIR, 'guardian.lock')
export const RELAY_PID_PATH = join(AGENT_DIR, 'relay.pid')
export const RELAY_LOG_PATH = join(AGENT_DIR, 'relay.log')
export const LAUNCH_LOG_PATH = join(AGENT_DIR, 'optimized-launch.log')
export const LAUNCH_AGENT_LABEL = 'com.local.miner-agent'
export const LAUNCH_AGENT_PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)
export const NOID_CONTROL_DIR = join(homedir(), 'Library', 'Application Support', 'NOID Miner')
export const NOID_CONTROL_SOCKET_PATH = join(NOID_CONTROL_DIR, 'control.sock')
export const NOID_APP_CANDIDATES = [
  '/Applications/NOID Miner.app',
  join(homedir(), 'Applications', 'NOID Miner.app'),
]

export const LOGS_DIR = join(homedir(), 'Library', 'Logs', 'IOTA Train at Home')
export const APP_BUNDLE_CANDIDATES = [
  '/Applications/IOTA Train at Home.app',
  join(homedir(), 'Applications', 'IOTA Train at Home.app'),
]
