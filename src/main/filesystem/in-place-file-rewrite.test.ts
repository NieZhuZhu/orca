import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { rewriteFileInPlace } from './in-place-file-rewrite'

const { failure } = vi.hoisted(() => {
  const state: { beforeThrow: (() => void) | null } = { beforeThrow: null }
  return { failure: state }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    writeSync: (fd: number, buffer: Buffer, ...rest: number[]) => {
      const beforeThrow = failure.beforeThrow
      if (!beforeThrow) {
        return actual.writeSync(fd, buffer, ...rest)
      }
      failure.beforeThrow = null
      actual.writeSync(fd, Buffer.from('model ='), 0, 7, 0)
      beforeThrow()
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
    }
  }
})

let root: string

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

it('never puts old bytes over a save that replaced the file during a failed rewrite', () => {
  root = mkdtempSync(join(tmpdir(), 'orca-in-place-'))
  const path = join(root, 'config.toml')
  writeFileSync(path, 'model = "o3"\n')
  // Codex saves by writing a temp file and renaming it over the config.
  failure.beforeThrow = () => {
    writeFileSync(`${path}.tmp`, 'model = "o5"\n[mcp_servers.x]\n')
    renameSync(`${path}.tmp`, path)
  }

  expect(() => rewriteFileInPlace(path, 'model = "o4"\n', () => undefined)).toThrow('no space')

  expect(readFileSync(path, 'utf8')).toBe('model = "o5"\n[mcp_servers.x]\n')
})
