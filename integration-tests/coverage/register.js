'use strict'

// Seed ROOT_ENV before loading `./runtime` so module-scope consumers (e.g. `COVERAGE_SLOWDOWN`)
// observe coverage as active from the first require.
const { realpathSync } = require('node:fs')
const path = require('node:path')
process.env.DD_TRACE_INTEGRATION_COVERAGE_ROOT = realpathSync(path.resolve(__dirname, '..', '..'))

const { installPatch } = require('./patch-child-process')
const { resetCollectorRoot } = require('./runtime')

resetCollectorRoot()
installPatch()
