'use strict'

const { execFileSync } = require('node:child_process')
const path = require('node:path')

const { getBunBinary } = require('./bun')

const repoRoot = path.join(__dirname, '..')

require('./patch-istanbul-lib-coverage')
require('./patch-v8-to-istanbul')

// npm can run prepare from a source archive before dev dependencies exist, so resolve the pinned Bun explicitly.
execFileSync(
  getBunBinary(),
  [`--config=${path.join(repoRoot, 'bunfig.toml')}`, 'install', '--silent', '--frozen-lockfile'],
  {
    cwd: path.join(repoRoot, 'vendor'),
    stdio: 'inherit',
  }
)
