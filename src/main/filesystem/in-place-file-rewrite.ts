import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readSync,
  statSync,
  writeSync
} from 'node:fs'

function readAll(fd: number): Buffer {
  const chunks: Buffer[] = []
  let position = 0
  for (;;) {
    const chunk = Buffer.allocUnsafe(64 * 1024)
    const bytesRead = readSync(fd, chunk, 0, chunk.length, position)
    if (bytesRead === 0) {
      return Buffer.concat(chunks)
    }
    chunks.push(chunk.subarray(0, bytesRead))
    position += bytesRead
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let written = 0
  while (written < bytes.length) {
    written += writeSync(fd, bytes, written, bytes.length - written, written)
  }
}

/** Whether `path` still names the file `fd` has open. */
function namesOpenFile(path: string, fd: number): boolean {
  const open = fstatSync(fd)
  const named = statSync(path)
  return open.dev === named.dev && open.ino === named.ino
}

/**
 * Rewrites a file in place, keeping its inode, through one descriptor. A failed write puts the old
 * bytes back through that same descriptor while the file holds only part of this write: a writer
 * that replaced the file by rename meanwhile left this descriptor on the old file, so its save is
 * never overwritten. The old bytes stay in memory only: no copy of the file is written anywhere.
 */
export function rewriteFileInPlace(
  path: string,
  contents: string,
  assertCurrent: () => void
): void {
  const fd = openSync(path, 'r+')
  try {
    assertCurrent()
    if (!namesOpenFile(path, fd)) {
      throw new Error(`File replaced while Orca was about to rewrite it: ${path}`)
    }
    const previous = readAll(fd)
    const next = Buffer.from(contents, 'utf-8')
    try {
      ftruncateSync(fd, 0)
      writeAll(fd, next)
      fsyncSync(fd)
    } catch (error) {
      restoreAfterFailedRewrite(fd, next, previous)
      throw error
    }
    // A rename in the guest after the check above leaves this write on a file no name reaches.
    if (!namesOpenFile(path, fd)) {
      throw new Error(`File replaced while Orca rewrote it: ${path}`)
    }
  } finally {
    closeSync(fd)
  }
}

function restoreAfterFailedRewrite(fd: number, next: Buffer, previous: Buffer): void {
  try {
    const current = readAll(fd)
    // Only part of this write: anything else was written by someone else, or is whole.
    if (current.length < next.length && next.subarray(0, current.length).equals(current)) {
      // Written over the prefix before trimming: a restore that fails midway never empties the file.
      writeAll(fd, previous)
      ftruncateSync(fd, previous.length)
      fsyncSync(fd)
    }
  } catch (error) {
    console.warn('[config-rewrite] Could not restore a file after a failed rewrite:', error)
  }
}
