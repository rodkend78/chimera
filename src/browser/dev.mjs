import { spawn } from 'node:child_process'

const children = [
  spawn(process.execPath, ['src/browser/server.mjs'], { stdio: 'inherit', env: process.env }),
  spawn('npm', ['run', 'dev:app'], { stdio: 'inherit', env: process.env }),
]

const stop = () => {
  for (const child of children) child.kill('SIGTERM')
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop)
for (const child of children) child.on('exit', (code) => {
  if (code && code !== 0) {
    stop()
    process.exitCode = code
  }
})
