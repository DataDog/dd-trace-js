'use strict'

// `index.d.ts` remains the public surface for the current released major. Other release
// lines keep their declarations in `index.d.v<major>.ts` so changes for an older or
// unreleased major do not leak into the current release.
//
// Wired into `npm pack` / `npm publish` via `prepack`. The swap is transient: it modifies
// the working tree only long enough for npm to read `index.d.ts`.

const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')
const { version } = require(path.join(repoRoot, 'package.json'))
const major = version.slice(0, version.indexOf('.'))

if (major !== '6') {
  const sourcePath = path.join(repoRoot, `index.d.v${major}.ts`)
  const destinationPath = path.join(repoRoot, 'index.d.ts')

  if (!fs.existsSync(sourcePath)) {
    process.stderr.write(
      `swap-versioned-types: ${sourcePath} not found; refusing to publish v${major} with outdated types.\n`
    )
    process.exit(1)
  }

  fs.copyFileSync(sourcePath, destinationPath)
}
