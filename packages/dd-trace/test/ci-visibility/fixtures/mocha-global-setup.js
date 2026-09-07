'use strict'

const { AsyncLocalStorage } = require('node:async_hooks')
const { channel } = require('node:diagnostics_channel')
const path = require('node:path')

const setup = require('../../../../../integration-tests/ci-visibility/mocha-global-setup')

// Internal context and coverage assertions belong to the focused regression
// matrix. The integration fixture controls ordering using only Node's lifecycle.
const context = new AsyncLocalStorage()
channel('ci:mocha:global:run').bindStore(context, () => 'configuration context')
if (process.env.MOCHA_SETUP_COVERAGE === 'true') {
  channel('ci:nyc:get-coverage').subscribe(({ onDone }) => queueMicrotask(() => onDone({})))
}

module.exports = { ...setup, context }

if (require.main === module) {
  const MochaPackage = require('mocha')
  const Mocha = MochaPackage.default ?? MochaPackage
  const mocha = new Mocha({
    globalSetup: setup.mochaGlobalSetup,
    globalTeardown: setup.mochaGlobalTeardown,
  })
  mocha.addFile(path.join(__dirname, 'mocha-global-setup-test.js'))
  mocha.run(failures => { process.exitCode = failures ? 1 : 0 })
}
