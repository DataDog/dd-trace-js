'use strict'

// Seed ROOT_ENV before requiring `./runtime` so `COVERAGE_SLOWDOWN` sees coverage as active.
const { realpathSync } = require('node:fs')
const path = require('node:path')
process.env._DD_TRACE_INTEGRATION_COVERAGE_ROOT = realpathSync(path.resolve(__dirname, '..', '..'))

const { installPatch } = require('./patch-child-process')
const { resetCollectorRoot } = require('./runtime')

resetCollectorRoot()
installPatch()
