'use strict'

const { execFileSync } = require('node:child_process')
const path = require('node:path')

const repoRoot = path.join(__dirname, '..')

if (process.env.npm_command !== 'pack') {
  require('./patch-istanbul-lib-coverage')
  require('./patch-v8-to-istanbul')

  execFileSync(
    'bun',
    [`--config=${path.join(repoRoot, 'bunfig.toml')}`, 'install', '--silent', '--frozen-lockfile'],
    {
      cwd: path.join(repoRoot, 'vendor'),
      stdio: 'inherit',
    }
  )
}
