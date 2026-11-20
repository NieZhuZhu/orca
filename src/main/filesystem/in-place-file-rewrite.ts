import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Rewrites a file in place, keeping its inode. An in-place write truncates first, so the old bytes
 * are copied to `backupFolder` (Orca's own data) beforehand: beside the file, a backup made from Windows in a
 * WSL home would get the guest's default permissions, wider than a config holding tokens.
 * A failed write puts them back only when the file still holds part of this write; the backup
 * stays when that can't be done, and goes once the file is whole again.
 */
export function rewriteFileInPlace(
  path: string,
  contents: string,
  assertCurrent: () => void,
  backupFolder: string
): void {
  assertCurrent()
  const previous = readFileSync(path)
  mkdirSync(backupFolder, { recursive: true, mode: 0o700 })
  const backupPath = join(backupFolder, `${randomUUID()}.bak`)
  try {
    writeFileSync(backupPath, previous, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    removeBackup(backupPath)
    throw error
  }
  let restored = true
  let writing = false
  try {
    // Copying the backup takes a round trip: an outside save meanwhile wins over this write.
    if (!readFileSync(path).equals(previous)) {
      throw new Error(`File changed while Orca was about to rewrite it: ${path}`)
    }
    writing = true
    writeFileSync(path, contents, 'utf-8')
  } catch (error) {
    // Nothing was written before the write began, so there is nothing to put back.
    restored = !writing || restoreAfterFailedRewrite(path, contents, previous)
    if (!restored) {
      console.warn('[config-rewrite] Kept the previous contents of', path, 'at', backupPath)
    }
    throw error
  } finally {
    if (restored) {
      removeBackup(backupPath)
    }
  }
}

function removeBackup(backupPath: string): void {
  try {
    rmSync(backupPath, { force: true })
  } catch {
    // A leftover copy in Orca's own folder is harmless; it must not fail a finished write.
  }
}

/** False when the old bytes may exist only in the backup. */
function restoreAfterFailedRewrite(path: string, contents: string, previous: Buffer): boolean {
  try {
    const current = readFileSync(path)
    const next = Buffer.from(contents, 'utf-8')
    // The old file, the whole new one, or someone else's save: leave it as it is.
    if (
      current.equals(previous) ||
      current.equals(next) ||
      !next.subarray(0, current.length).equals(current)
    ) {
      return true
    }
    writeFileSync(path, previous)
    return true
  } catch {
    return false
  }
}
