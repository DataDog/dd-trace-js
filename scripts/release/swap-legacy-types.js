'use strict'

// Publish the frozen TypeScript surface that matches the release's major.
//
// `index.d.ts` on `master` always describes the newest major (the one under active
// development). Each shipping older major keeps its surface frozen in `index.d.v<major>.ts`
// so a patch/minor release of that major ships types that match its runtime contract instead
// of the newer major's cleanups (dropped deprecations, widened return types, etc.).
//
// Wired into `npm pack` / `npm publish` via `prepack`. It self-gates on the major in
// `package.json`: a release whose major has a frozen `index.d.v<major>.ts` swaps it over
// `index.d.ts`; the newest major has no such file, so this is a no-op there. Adding a new
// frozen surface is therefore a single file drop -- no change here. The swap is transient --
// it modifies the working tree only long enough for `npm pack` to read the file. Nothing is
// committed.

const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')
const { version } = require(path.join(repoRoot, 'package.json'))

const major = version.slice(0, version.indexOf('.'))
const sourcePath = path.join(repoRoot, `index.d.v${major}.ts`)

if (fs.existsSync(sourcePath)) {
  const destinationPath = path.join(repoRoot, 'index.d.ts')
  fs.copyFileSync(sourcePath, destinationPath)
}
