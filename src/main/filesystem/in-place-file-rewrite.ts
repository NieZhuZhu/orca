import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'

/**
 * Rewrites a file in place, keeping its inode. An in-place write truncates first, so the old bytes
 * go to a new owner-only `<path>.orca-backup-<id>` beforehand. A failed write puts them back only
 * when the file still holds part of this write; the backup stays when that can't be done, and goes
 * once the file is whole again.
 */
export function rewriteFileInPlace(
  path: string,
  contents: string,
  assertCurrent: () => void
): void {
  const previous = readFileSync(path)
  const backupPath = `${path}.orca-backup-${randomUUID()}`
  writeFileSync(backupPath, previous, { mode: 0o600, flag: 'wx' })
  let restored = true
  try {
    // Backing up takes a round trip over 9P: check for an outside save once more before truncating.
    assertCurrent()
    writeFileSync(path, contents, 'utf-8')
  } catch (error) {
    restored = restoreAfterFailedRewrite(path, contents, previous)
    throw error
  } finally {
    if (restored) {
      rmSync(backupPath, { force: true })
    }
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
