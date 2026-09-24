'use strict'

const { AsyncLocalStorage } = require('node:async_hooks')
const path = require('node:path')

const { channel } = require('dc-polyfill')

const setup = require('../../../../../integration-tests/ci-visibility/mocha-global-setup')

// Internal context and coverage assertions belong to the focused regression
// matrix. The integration fixture controls ordering using only Node's lifecycle.
// Use the same channel implementation as the tracer before registering stores;
// applying the Node 18 polyfill later would replace native store bindings.
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
