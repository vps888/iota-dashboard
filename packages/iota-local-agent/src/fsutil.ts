import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

// 原子写:先写临时文件再 rename,写完收紧权限,避免读到半截内容
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(value, undefined, 2) + '\n', { mode: 0o600 })
  await rename(tmp, path)
  await chmod(path, 0o600).catch(() => {})
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}
