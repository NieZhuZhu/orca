import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import Database from './sqlite/sync-database'
import type { AgentJournalRenderItem } from '../shared/agent-session/journal/agent-session-journal-types'
import { openJournalDomainDatabase } from './native-chat/agent-session-journal/database/journal-domain-database'
import { runJournalTransaction } from './native-chat/agent-session-journal/database/journal-database'
import { writeJournalDomainCurrentItem } from './native-chat/agent-session-journal/journal-domain-current-item'
import * as Real from './native-chat/agent-session-journal/journal-stored-output'
import type * as StoredOutput from './native-chat/agent-session-journal/journal-stored-output'
import { openSessionSearchDatabase } from './ai-vault-search/storage/session-search-schema'
import { deleteSearchMessages, insertSearchMessage } from './ai-vault-search/storage/session-search-message-rows'

// Seeds are written inline, as every released build wrote them.
const switches = vi.hoisted(() => ({ writes: null as boolean | null }))
vi.mock('./native-chat/agent-session-journal/journal-stored-output', async (load) => {
  const actual = await load<typeof StoredOutput>()
  return {
    ...actual,
    get JOURNAL_STORED_OUTPUT_WRITES() {
      return switches.writes ?? actual.JOURNAL_STORED_OUTPUT_WRITES
    }
  }
})

const ROOT = process.env.MEASURE_ROOT ?? join(homedir(), '.cache/orca-jobs/dbgrowth-reclaim')
const PART = process.env.MEASURE_PART ?? 'journal'
const SCALE = Number(process.env.MEASURE_SCALE ?? 1)
const OUT = process.env.MEASURE_OUT ?? join(ROOT, `${PART}.json`)
const out: Record<string, unknown> = { part: PART }
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 1))

let seed = 1
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
const words = Array.from({ length: 20000 }, () => Math.floor(rand() * 2 ** 40).toString(36))
const pick = () => words[Math.floor(rand() ** 2 * 20000)]!
function lines(bytes: number) {
  const parts: string[] = []
  let n = 0
  while (n < bytes) {
    const l = `src/${pick()}/${pick()}.ts:${Math.floor(rand() * 900)}  ${Array.from({ length: 4 + Math.floor(rand() * 10) }, pick).join(' ')} ${Math.floor(rand() * 2 ** 32).toString(16)}`
    parts.push(l)
    n += l.length + 1
  }
  return parts.join('\n')
}
const outputBytes = () => {
  const r = rand()
  return r < 0.61 ? 300 + rand() * 3500 : r < 0.98 ? 4096 + rand() * 14000 : r < 0.998 ? 32768 + rand() * 40000 : 131072 + rand() * 300000
}

function procWrite(): number {
  try {
    return Number(/^write_bytes: (\d+)/m.exec(readFileSync('/proc/self/io', 'utf8'))?.[1] ?? 0)
  } catch {
    return 0
  }
}
const mb = (n: number) => Math.round(n / 2 ** 20)
function dirBytes(dir: string) {
  return existsSync(dir) ? readdirSync(dir).reduce((sum, f) => sum + statSync(join(dir, f)).size, 0) : 0
}

/** Runs batches with a yield between them; reports wall, longest batch, bytes written and peak target size. */
async function phase(name: string, target: string, run: (step: (fn: () => boolean) => Promise<void>) => Promise<void>) {
  const started = performance.now()
  const writeStart = procWrite()
  let longest = 0
  let batches = 0
  let peak = 0
  const step = async (fn: () => boolean) => {
    for (;;) {
      const t = performance.now()
      const more = fn()
      longest = Math.max(longest, performance.now() - t)
      batches++
      if (batches % 50 === 0) {
        peak = Math.max(peak, dirBytes(target))
      }
      await new Promise((r) => setImmediate(r))
      if (!more) {
        return
      }
    }
  }
  let error: string | null = null
  try {
    await run(step)
  } catch (e) {
    error = String(e)
  }
  peak = Math.max(peak, dirBytes(target))
  out[name] = {
    wallSec: Math.round((performance.now() - started) / 100) / 10,
    longestBlockMs: Math.round(longest),
    batches,
    writtenMB: mb(procWrite() - writeStart),
    peakTargetMB: mb(peak),
    finalTargetMB: mb(dirBytes(target)),
    error
  }
  save()
}

async function journalPart() {
  const seedDir = join(ROOT, 'journal-seed')
  const seedFile = join(seedDir, 'agent-session-domain.db')
  if (!existsSync(join(seedDir, 'done'))) {
    rmSync(seedDir, { recursive: true, force: true })
    mkdirSync(seedDir, { recursive: true })
    switches.writes = false
    const { db } = openJournalDomainDatabase(seedFile)
    const chats = 1900
    const insert = db.prepare(
      `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence) VALUES(?,?,?,900,1)`
    )
    for (let w = 0; w < chats; w++) insert.run(`ws-${w}`, `chat-${w}`, 'epoch')
    const total = Math.round(1_250_000 / SCALE)
    const template = Math.min(50_000, total)
    let next = 0
    for (let i = 0; i < template; i += 50) {
      runJournalTransaction(db, () => {
        for (let j = i; j < i + 50; j++) {
          next++
          const head = lines(outputBytes())
          writeJournalDomainCurrentItem(db, { sessionId: `chat-${j % chats}`, epoch: 'epoch' }, {
            item: { itemId: `t${next}`, revision: 1, sequence: next, observedAt: 1, body: { kind: 'tool-call', name: 'shell', callId: `t${next}`, input: { command: `rg ${pick()}` }, state: 'completed', output: { head, byteLength: Buffer.byteLength(head), digest: String(next), truncated: false } } } as AgentJournalRenderItem,
            hidden: false,
            ownerFence: 1
          })
        }
      })
    }
    const cols = db.prepare('PRAGMA table_info(journal_items)').all().map((c) => String(c.name))
    for (let copy = 1; copy * template < total; copy++) {
      const sel = cols.map((c) => (c === 'item_id' ? `item_id||'-c${copy}'` : c === 'ordinal' || c === 'sequence' ? `${c}+${copy * template}` : c)).join(',')
      db.exec(`INSERT INTO journal_items(${cols.join(',')}) SELECT ${sel} FROM journal_items WHERE rowid<=${Math.min(template, total - copy * template)}`)
    }
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
    switches.writes = null
    writeFileSync(join(seedDir, 'done'), '1')
  }
  out.seedMB = mb(statSync(seedFile).size)
  save()
  expect(Real.JOURNAL_STORED_OUTPUT_WRITES).toBe(true)

  // J1: plain copy of live pages, the floor for any copy.
  const j1 = join(ROOT, 'j1')
  rmSync(j1, { recursive: true, force: true })
  mkdirSync(j1, { recursive: true })
  await phase('J1_vacuumInto', j1, async (step) => {
    const src = new Database(seedFile, { readonly: true })
    await step(() => {
      src.exec(`VACUUM INTO '${join(j1, 'copy.db')}'`)
      return false
    })
    src.close()
  })
  rmSync(j1, { recursive: true, force: true })

  // J2: batched copy that stores outputs compressed on the way, as a swap-in replacement would.
  const copy = (dir: string, limitPages?: number, stopAfterBatches?: number) =>
    phase(limitPages ? 'J2_diskFull' : stopAfterBatches ? 'J2_abandoned' : 'J2_compressingCopy', dir, async (step) => {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      const { db } = openJournalDomainDatabase(join(dir, 'agent-session-domain.db'))
      if (limitPages) db.pragma(`max_page_count = ${limitPages}`)
      db.exec(`ATTACH '${seedFile}' AS src`)
      const cols = db.prepare('PRAGMA src.table_info(journal_items)').all().map((c) => String(c.name))
      const insert = db.prepare(`INSERT INTO main.journal_items(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`)
      const page = db.prepare(`SELECT rowid AS r, * FROM src.journal_items WHERE rowid>? ORDER BY rowid LIMIT 256`)
      const payloadAt = cols.indexOf('payload_json')
      const blobAt = cols.indexOf('output_blob')
      const wireBytesAt = cols.indexOf('wire_bytes')
      let after = 0
      let batches = 0
      await step(() => {
        const rows = page.all(after)
        db.exec('BEGIN')
        for (const row of rows) {
          after = Number(row.r)
          const values = cols.map((c) => row[c] as never)
          if (row.kind === 'tool-call' || row.kind === 'diff') {
            const stored = Real.storeJournalItemOutput(JSON.parse(String(row.payload_json)))
            if (stored) {
              values[wireBytesAt] ??= Buffer.byteLength(String(row.payload_json)) as never
              values[payloadAt] = JSON.stringify(stored.item) as never
              values[blobAt] = stored.blob as never
            }
          }
          insert.run(...values)
        }
        db.exec('COMMIT')
        batches++
        return rows.length === 256 && !(stopAfterBatches && batches >= stopAfterBatches)
      })
      db.exec('DETACH src')
      if (!limitPages && !stopAfterBatches) db.pragma('wal_checkpoint(TRUNCATE)')
      db.close()
    })
  const j2 = join(ROOT, 'j2')
  await copy(j2)
  out.J2_rows = Number(new Database(join(j2, 'agent-session-domain.db'), { readonly: true }).prepare('SELECT COUNT(*) n FROM journal_items').get()!.n)
  rmSync(j2, { recursive: true, force: true })
  // Disk nearly full: the target hits its page cap partway; the source must be untouched.
  await copy(join(ROOT, 'j2-full'), Math.round(200_000 / SCALE))
  const check = new Database(seedFile, { readonly: true })
  out.J2_diskFull_sourceQuickCheck = String(Object.values(check.prepare('PRAGMA quick_check').get()!)[0])
  check.close()
  rmSync(join(ROOT, 'j2-full'), { recursive: true, force: true })
  // Quit mid-copy: stop after 500 batches without finishing; the partial target must open and be removable.
  const abandoned = join(ROOT, 'j2-abandoned')
  await copy(abandoned, undefined, Math.max(2, Math.round(500 / SCALE)))
  const partial = new Database(join(abandoned, 'agent-session-domain.db'), { readonly: true })
  out.J2_abandoned_partialRows = Number(partial.prepare('SELECT COUNT(*) n FROM journal_items').get()!.n)
  partial.close()
  rmSync(abandoned, { recursive: true, force: true })
  out.J2_abandoned_removed = !existsSync(abandoned)
  save()
}

async function ftsPart() {
  const seedDir = join(ROOT, 'fts-seed')
  const seedFile = join(seedDir, 'session-search.sqlite')
  if (!existsSync(join(seedDir, 'done'))) {
    rmSync(seedDir, { recursive: true, force: true })
    mkdirSync(seedDir, { recursive: true })
    const db = openSessionSearchDatabase(seedFile)
    const sessions = Math.round(32000 / SCALE)
    const text = () => Array.from({ length: 40 + Math.floor(rand() * 400) }, pick).join(' ')
    const write = (s: number) => {
      db.exec('BEGIN IMMEDIATE')
      deleteSearchMessages(db, s)
      for (let m = 0; m < 40; m++) {
        insertSearchMessage(db, s, { role: m % 4 === 0 ? 'user' : 'assistant', text: text(), timestamp: null, textTruncated: false } as never)
      }
      db.exec('COMMIT')
    }
    for (let round = 0; round < 3; round++) for (let s = 1; s <= sessions; s++) write(s)
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
    writeFileSync(join(seedDir, 'done'), '1')
  }
  const fts = (file: string) => {
    const db = new Database(file, { readonly: true })
    const r = mb(Number(db.prepare('SELECT SUM(length(block)) n FROM messages_fts_data').get()!.n))
    db.close()
    return r
  }
  out.seedMB = mb(statSync(seedFile).size)
  out.seedFtsDataMB = fts(seedFile)
  save()

  // F1: plain copy keeps every dead segment entry.
  const f1 = join(ROOT, 'f1')
  rmSync(f1, { recursive: true, force: true })
  mkdirSync(f1, { recursive: true })
  await phase('F1_vacuumInto', f1, async (step) => {
    const src = new Database(seedFile, { readonly: true })
    await step(() => {
      src.exec(`VACUUM INTO '${join(f1, 'copy.sqlite')}'`)
      return false
    })
    src.close()
  })
  out.F1_ftsDataMB = fts(join(f1, 'copy.sqlite'))
  rmSync(f1, { recursive: true, force: true })

  // F2 (A): fresh FTS table in the same file, filled in batches from the content table, then swapped.
  const f2 = join(ROOT, 'f2')
  rmSync(f2, { recursive: true, force: true })
  mkdirSync(f2, { recursive: true })
  copyFileSync(seedFile, join(f2, 'session-search.sqlite'))
  const f2File = join(f2, 'session-search.sqlite')
  await phase('F2_inFileRebuild', f2, async (step) => {
    const db = openSessionSearchDatabase(f2File)
    db.exec(`CREATE VIRTUAL TABLE messages_fts_next USING fts5(user_text, assistant_text, tool_text, identifiers, tokenize="unicode61 tokenchars '_.-/+'", detail=full)`)
    db.exec(`INSERT INTO messages_fts_next(messages_fts_next, rank) VALUES ('automerge', 8)`)
    const page = db.prepare('INSERT INTO messages_fts_next(rowid,user_text,assistant_text,tool_text,identifiers) SELECT id,c0,c1,c2,c3 FROM messages_fts_content WHERE id>? ORDER BY id LIMIT 2000')
    const last = db.prepare('SELECT MAX(rowid) n FROM messages_fts_next')
    let after = 0
    await step(() => {
      const changes = page.run(after).changes
      after = Number(last.get()!.n ?? after)
      return changes === 2000
    })
    const t = performance.now()
    db.exec('BEGIN IMMEDIATE')
    db.exec('DROP TABLE messages_fts')
    db.exec('ALTER TABLE messages_fts_next RENAME TO messages_fts')
    db.exec('COMMIT')
    out.F2_swapBlockMs = Math.round(performance.now() - t)
    db.pragma('wal_checkpoint(TRUNCATE)')
    out.F2_freelistMB = mb(Number(db.pragma('freelist_count', { simple: true })) * 4096)
    db.close()
  })
  out.F2_ftsDataMB = fts(f2File)
  rmSync(f2, { recursive: true, force: true })

  // F3 (B): new file, every table copied in batches with FTS re-inserted, then the file is swapped.
  const f3 = join(ROOT, 'f3')
  rmSync(f3, { recursive: true, force: true })
  mkdirSync(f3, { recursive: true })
  const f3File = join(f3, 'session-search.sqlite')
  await phase('F3_newFileCopy', f3, async (step) => {
    const db = openSessionSearchDatabase(f3File)
    db.exec(`ATTACH '${seedFile}' AS src`)
    db.exec('DELETE FROM main.meta')
    for (const table of ['meta', 'sessions', 'files']) {
      db.exec(`INSERT INTO main.${table} SELECT * FROM src.${table}`)
    }
    const msgs = db.prepare('INSERT INTO main.messages SELECT * FROM src.messages WHERE id>? ORDER BY id LIMIT 2000')
    const ftsRows = db.prepare('INSERT INTO main.messages_fts(rowid,user_text,assistant_text,tool_text,identifiers) SELECT id,c0,c1,c2,c3 FROM src.messages_fts_content WHERE id>? AND id<=? ORDER BY id')
    const last = db.prepare('SELECT MAX(id) n FROM main.messages')
    let after = 0
    await step(() => {
      db.exec('BEGIN')
      const changes = msgs.run(after).changes
      const upto = Number(last.get()!.n ?? after)
      ftsRows.run(after, upto)
      db.exec('COMMIT')
      after = upto
      return changes === 2000
    })
    db.exec('DETACH src')
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
  })
  out.F3_ftsDataMB = fts(f3File)
  rmSync(f3, { recursive: true, force: true })
  save()
}

it('measures reclaim by copy and by in-file rebuild', { timeout: 10 * 3_600_000 }, async () => {
  mkdirSync(ROOT, { recursive: true })
  await (PART === 'fts' ? ftsPart() : journalPart())
  process.stderr.write(`MEASURE ${JSON.stringify(out)}\n`)
})
