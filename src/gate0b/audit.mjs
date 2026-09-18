export const REQUIRED_TASKS = [
  'source-integrity',
  'preset-manifests',
  'profile-web-config',
  'profile-headless-config',
  'headless-keyless-roundtrip',
  'code-mode-keyless',
  'web-loopback',
  'web-recovery',
  'snapshot-replay',
]

function parseRestarts(serviceText) {
  const match = /(?:^|\n)NRestarts=(\d+)(?:\n|$)/.exec(serviceText ?? '')
  return match === null ? null : Number(match[1])
}

export function auditSoak({ state, matrix, events, runStart, budgetEnd }) {
  const checks = []
  const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail })
  const durationHours = state?.completedAt && state?.startedAt
    ? (Date.parse(state.completedAt) - Date.parse(state.startedAt)) / 3_600_000
    : 0
  check('runner-completed', state?.completed === true, state?.completedAt ?? null)
  check('elapsed-48-hours', durationHours >= 48, durationHours)
  check('source-commit', matrix?.source?.commit === 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e', matrix?.source?.commit ?? null)
  check('source-tree', matrix?.source?.tree === '53915efe4e2126cc7779b73dfc8a3bcec5318c44', matrix?.source?.tree ?? null)
  check('profiles', JSON.stringify(matrix?.profiles) === JSON.stringify(['web', 'headless']), matrix?.profiles ?? null)
  check('presets', JSON.stringify(matrix?.presets) === JSON.stringify(['standard', 'code', 'minimal', 'cordis']), matrix?.presets ?? null)

  const rows = new Map((matrix?.matrix ?? []).map(row => [row.name, row]))
  for (const name of REQUIRED_TASKS) {
    const row = rows.get(name)
    check(`matrix-${name}`, row?.runs > 0 && row?.failures === 0, row ?? null)
  }

  const samples = events.filter(event => event.type === 'host-sample')
  const bootIds = [...new Set(samples.map(event => event.bootId))]
  const runnerRestarts = samples.map(event => parseRestarts(event.services?.runner)).filter(Number.isInteger)
  const webRestarts = samples.map(event => parseRestarts(event.services?.web)).filter(Number.isInteger)
  check('host-sample-coverage', samples.length >= 48, samples.length)
  check('single-host-boot', bootIds.length === 1, bootIds)
  check('runner-service-restarts', runnerRestarts.length > 0 && Math.max(...runnerRestarts) === 0, runnerRestarts.length ? Math.max(...runnerRestarts) : null)
  check('web-restarts-bounded', webRestarts.length > 0 && Math.max(...webRestarts) <= 12, webRestarts.length ? Math.max(...webRestarts) : null)

  const startAmount = Number(runStart?.budgetStart?.Amount)
  const endAmount = Number(budgetEnd?.Amount)
  const observedBudgetDeltaUsd = Number.isFinite(startAmount) && Number.isFinite(endAmount) ? Number((endAmount - startAmount).toFixed(4)) : null
  check('budget-observation-present', observedBudgetDeltaUsd !== null, { startAmount, endAmount, unit: budgetEnd?.Unit ?? runStart?.budgetStart?.Unit ?? null })
  check('infrastructure-ceiling', observedBudgetDeltaUsd !== null && observedBudgetDeltaUsd <= 50, observedBudgetDeltaUsd)

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    pass: checks.every(item => item.pass),
    durationHours,
    estimatedInfrastructureCostUsd: state?.estimatedInfrastructureCostUsd ?? null,
    observedBudgetDeltaUsd,
    budgetObservationNote: 'AWS Budget calculated spend can lag usage; rerun this audit if the ending value has not settled.',
    checks,
  }
}
