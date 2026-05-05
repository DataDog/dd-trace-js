'use strict'

// Wrapper around c8 that mirrors what `nyc.config.js` previously did for
// `tempDir` / `reportDir`: it makes the output per-Node-version-and-script so
// a single CI job that runs coverage sequentially across multiple Node.js
// versions doesn't collide. Static c8 config (include/exclude/reporter) lives
// in `.c8rc.json`.

const { spawn } = require('node:child_process')
const path = require('node:path')

let event = process.env.npm_lifecycle_event ?? ''
if (process.env.PLUGINS) event += `-${process.env.PLUGINS}`
const label = `-${event.replaceAll(/[^a-zA-Z0-9._-]+/g, '-')}`
const dirSuffix = `node-${process.version}${label}`

const c8 = require.resolve('c8/bin/c8.js')

const args = [
  c8,
  '--temp-directory', path.join('.c8_output', dirSuffix),
  '--reports-dir', path.join('coverage', dirSuffix),
  ...process.argv.slice(2),
]

const child = spawn(process.execPath, args, { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
