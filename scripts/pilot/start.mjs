import { formatPilotReadiness, inspectPilotReadiness } from '../../src/pilot/readiness.mjs'

const result = await inspectPilotReadiness()
console.log(formatPilotReadiness(result))

if (!result.ready) {
  process.exitCode = 1
} else {
  await import('../../src/browser/server.mjs')
}
