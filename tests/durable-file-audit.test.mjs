import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DurableFileAuditLog } from '../src/audit/durable-file-log.mjs'

test('durable audit retains and extends a valid hash chain across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-audit-'))
  const filePath = join(directory, 'events.jsonl')
  try {
    const first = await DurableFileAuditLog.open({ filePath })
    const head = first.append({ kind: 'first', value: 1 }).entryHash
    const reopened = await DurableFileAuditLog.open({ filePath })
    assert.equal(reopened.verify().valid, true)
    assert.equal(reopened.verify().head, head)
    reopened.append({ kind: 'second', value: 2 })
    assert.equal(reopened.verify().entries, 2)
    assert.equal((await stat(filePath)).mode & 0o777, 0o600)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('durable audit refuses a modified hash chain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-audit-invalid-'))
  const filePath = join(directory, 'events.jsonl')
  try {
    const audit = await DurableFileAuditLog.open({ filePath })
    audit.append({ kind: 'original' })
    const entry = JSON.parse((await readFile(filePath, 'utf8')).trim())
    entry.fact.kind = 'tampered'
    await writeFile(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    await assert.rejects(DurableFileAuditLog.open({ filePath }), /AUDIT_CHAIN_INVALID/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
