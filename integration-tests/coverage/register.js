'use strict'

// Seed the coverage-active flag before any `./runtime` consumer is loaded so module-scope
// `COVERAGE_SLOWDOWN` checks observe coverage as active. `applyCoverageEnv` overrides this
// per child.
const { realpathSync } = require('node:fs')
const path = require('node:path')
process.env.DD_TRACE_INTEGRATION_COVERAGE_ROOT = realpathSync(path.resolve(__dirname, '..', '..'))

const { installPatch } = require('./patch-child-process')
const { resetCollectorRoot } = require('./runtime')

resetCollectorRoot()
installPatch()
