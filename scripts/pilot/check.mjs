import { formatPilotReadiness, inspectPilotReadiness } from '../../src/pilot/readiness.mjs'

const result = await inspectPilotReadiness()
console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : formatPilotReadiness(result))
if (!result.ready) process.exitCode = 1
