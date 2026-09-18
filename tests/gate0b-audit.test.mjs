import assert from 'node:assert/strict'
import { test } from 'node:test'
import { auditSoak, REQUIRED_TASKS } from '../src/gate0b/audit.mjs'

function fixture() {
  const startedAt = '2026-08-25T00:00:00.000Z'
  const completedAt = '2026-08-27T00:00:01.000Z'
  const matrix = REQUIRED_TASKS.map(name => ({ name, runs: 1, passes: 1, failures: 0, last: completedAt }))
  const events = Array.from({ length: 48 }, (_, index) => ({
    type: 'host-sample',
    at: new Date(Date.parse(startedAt) + index * 3_600_000).toISOString(),
    bootId: 'one-boot',
    services: { runner: 'NRestarts=0\nActiveState=active', web: 'NRestarts=12\nActiveState=active' },
  }))
  return {
    state: { completed: true, startedAt, completedAt, estimatedInfrastructureCostUsd: 5.04 },
    matrix: { source: { commit: 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e', tree: '53915efe4e2126cc7779b73dfc8a3bcec5318c44' }, profiles: ['web', 'headless'], presets: ['standard', 'code', 'minimal', 'cordis'], matrix },
    events,
    runStart: { budgetStart: { Amount: '10.00', Unit: 'USD' } },
    budgetEnd: { Amount: '15.50', Unit: 'USD' },
  }
}

test('final soak audit passes only complete, clean, budgeted evidence', () => {
  const report = auditSoak(fixture())
  assert.equal(report.pass, true)
  assert.equal(report.observedBudgetDeltaUsd, 5.5)
})

test('final soak audit fails a task regression and a second boot', () => {
  const data = fixture()
  data.matrix.matrix.find(row => row.name === 'code-mode-keyless').failures = 1
  data.events.at(-1).bootId = 'second-boot'
  const report = auditSoak(data)
  assert.equal(report.pass, false)
  assert.equal(report.checks.find(item => item.name === 'matrix-code-mode-keyless').pass, false)
  assert.equal(report.checks.find(item => item.name === 'single-host-boot').pass, false)
})
