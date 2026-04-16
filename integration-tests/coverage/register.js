'use strict'

const { installPatch } = require('./patch-child-process')
const { REPO_ROOT, ROOT_ENV, canonicalizePath, ensureCollectorRoot, resetCollectorRoot } = require('./runtime')

// Seed the coverage-active signal for the Mocha process itself. `applyCoverageEnv` then
// replaces this with each child's resolved dd-trace root for every spawn.
process.env[ROOT_ENV] = canonicalizePath(REPO_ROOT)
resetCollectorRoot()
installPatch()

exports.mochaHooks = {
  async beforeAll () {
    await ensureCollectorRoot()
  },
}
