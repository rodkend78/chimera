import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GatewayReplayLedger } from '../src/gateway-replay-ledger.mjs'

test('replay ledger preserves action ids across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-replay-'))
  const filePath = join(directory, 'actions.jsonl')
  try {
    const first = await GatewayReplayLedger.open({ filePath })
    assert.equal(first.has('action-1'), false)
    first.record('action-1')
    assert.equal(first.has('action-1'), true)

    const reopened = await GatewayReplayLedger.open({ filePath })
    assert.equal(reopened.has('action-1'), true)
    assert.equal(reopened.record('action-1'), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('replay ledger fails closed on malformed persisted entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-replay-invalid-'))
  const filePath = join(directory, 'actions.jsonl')
  try {
    await writeFile(filePath, '{"schema":"wrong","actionId":"action-1"}\n', { mode: 0o600 })
    await assert.rejects(GatewayReplayLedger.open({ filePath }), /GATEWAY_REPLAY_LEDGER_INVALID/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
