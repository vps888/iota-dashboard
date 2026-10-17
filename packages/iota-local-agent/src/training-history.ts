import { mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { LOGS_DIR, AGENT_DIR } from './paths.js'
import { parseLocalLogTimestamp } from './guardian.js'

export interface TrainingRecord { at: number; file: string; line: number; text: string }
interface Cursor { identity: string; offset: number; line: number }
interface History { version: 1; latest: TrainingRecord | null; cursors: Record<string, Cursor> }
const TRAINING = /Starting FORWARD pass|after training forward pass|training\.state accepted \{ state: 'training(?:_tick)?'/

// Serialize readers so simultaneous status requests cannot overwrite a newer checkpoint.
let pending: Promise<unknown> = Promise.resolve()
export function latestTraining(logDir = LOGS_DIR, statePath = join(AGENT_DIR, 'training-history.json')): Promise<TrainingRecord | null> {
  const task = pending.then(() => scan(logDir, statePath))
  pending = task.catch(() => {})
  return task
}
async function scan(logDir: string, statePath: string): Promise<TrainingRecord | null> {
  let history: History = { version: 1, latest: null, cursors: {} }
  try {
    const saved = JSON.parse(await readFile(statePath, 'utf8')) as History
    if (saved.version === 1 && saved.cursors && (!saved.latest || (Number.isFinite(saved.latest.at) && saved.latest.at > 0))) history = saved
  } catch { /* First query or damaged checkpoint: rebuild from logs. */ }
  const names = (await readdir(logDir)).filter((name) => /^\d{4}-\d{2}-\d{2}.*-(?:main|cli).*\.log$/.test(name)).sort().reverse()
  for (const name of names) {
    // Inspect all files for the latest known day, then stop at older dates.
    if (history.latest && name.slice(0, 10) < history.latest.file.slice(0, 10)) break
    const path = join(logDir, name)
    const info = await stat(path)
    const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`
    const old = history.cursors[name]
    const cursor: Cursor = old?.identity === identity && old.offset <= info.size ? old : { identity, offset: 0, line: 0 }
    const handle = await open(path, 'r')
    try {
      let offset = cursor.offset
      let line = cursor.line
      // Read only the bytes after the last complete line. A partial last line is retried.
      const stream = handle.createReadStream({ start: offset, end: Math.max(offset, info.size - 1), autoClose: false })
      let remainder = Buffer.alloc(0)
      if (offset < info.size) for await (const chunk of stream) {
        remainder = Buffer.concat([remainder, chunk as Buffer])
        let newline: number
        let consumed = 0
        while ((newline = remainder.indexOf(10, consumed)) !== -1) {
          const bytes = remainder.subarray(consumed, newline + 1)
          const text = bytes.toString('utf8').trimEnd()
          offset += bytes.length
          line++
          const stamp = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\]/.exec(text)
          if (stamp && TRAINING.test(text)) {
            const at = parseLocalLogTimestamp(stamp[1]!)
            if (Number.isFinite(at) && (!history.latest || at > history.latest.at)) history.latest = { at, file: name, line, text }
          }
          consumed = newline + 1
        }
        remainder = remainder.subarray(consumed)
      }
      history.cursors[name] = { identity, offset, line }
    } finally { await handle.close() }
  }
  await mkdir(dirname(statePath), { recursive: true })
  const temp = `${statePath}.tmp`
  await writeFile(temp, JSON.stringify(history, null, 2) + '\n', { mode: 0o600 })
  await rename(temp, statePath)
  return history.latest
}
