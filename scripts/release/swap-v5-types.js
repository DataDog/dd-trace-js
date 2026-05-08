'use strict'

// Copy `index.d.v5.ts` over `index.d.ts` so the published v5 tarball ships the v5 type
// surface even after master's `index.d.ts` has dropped types in the v6 cleanup. Wired into
// `npm pack` / `npm publish` via `prepack` and self-gates on the major in `package.json`,
// so it is a no-op on master and any future major. The swap is transient -- it modifies the
// working tree only long enough for `npm pack` to read the file. Nothing is committed.

const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')
const { version } = require(path.join(repoRoot, 'package.json'))

if (version.startsWith('5.')) {
  const sourcePath = path.join(repoRoot, 'index.d.v5.ts')
  const destinationPath = path.join(repoRoot, 'index.d.ts')

  if (!fs.existsSync(sourcePath)) {
    process.stderr.write(
      `swap-v5-types: ${sourcePath} not found; refusing to publish a v5 release with an outdated index.d.ts.\n`
    )
    process.exit(1)
  }

  fs.copyFileSync(sourcePath, destinationPath)
}
