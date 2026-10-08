import { stat } from 'node:fs/promises'
import { appendFile, rename } from 'node:fs/promises'
import { STATE_PATH, EVENTS_PATH } from './paths.js'
import { atomicWriteJson, readJson } from './fsutil.js'

const ROTATE_BYTES = 2 * 1024 * 1024

export function clockString(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString()
}

export async function readState<T extends object>(): Promise<Partial<T>> {
  return (await readJson<Partial<T>>(STATE_PATH)) ?? {}
}

export async function saveState(state: object): Promise<void> {
  await atomicWriteJson(STATE_PATH, state)
}

export async function event(message: string): Promise<void> {
  try {
    const info = await stat(EVENTS_PATH).catch(() => null)
    if (info && info.size > ROTATE_BYTES) {
      await rename(EVENTS_PATH, EVENTS_PATH.replace(/\.log$/, '.previous.log')).catch(() => {})
    }
    await appendFile(EVENTS_PATH, `[${clockString(Date.now() / 1000)}] ${message}\n`)
  } catch {
    // 日志写不进去不能影响守护
  }
}
