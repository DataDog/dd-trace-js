'use strict'

// Copy `index.d.v5.ts` over `index.d.ts` so the published v5 tarball ships the v5 type
// surface even after master's `index.d.ts` has dropped types in the v6 cleanup. Idempotent:
// running it twice is a no-op. Runs from the repo root.

const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')
const sourcePath = path.join(repoRoot, 'index.d.v5.ts')
const destinationPath = path.join(repoRoot, 'index.d.ts')

if (!fs.existsSync(sourcePath)) {
  process.stderr.write(`swap-v5-types: ${sourcePath} not found; nothing to swap.\n`)
  process.exit(1)
}

fs.copyFileSync(sourcePath, destinationPath)
