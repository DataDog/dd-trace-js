'use strict'

const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')
const { channel } = require('node:diagnostics_channel')
const path = require('node:path')

const configurationFirst = process.env.MOCHA_SETUP_ORDER === 'configuration-first'
const context = exports.context = new AsyncLocalStorage()
channel('ci:mocha:global:run').bindStore(context, () => 'configuration context')
let configurationFinished = false
let finishSetup

channel('ci:mocha:global:run').subscribe(() => {
  configurationFinished = true
  // runStores invokes the start callback after publishing this channel. Release
  // global setup on the next turn so that callback definitely runs first.
  if (configurationFirst) setImmediate(() => finishSetup())
})

if (process.env.MOCHA_SETUP_COVERAGE === 'true') {
  channel('ci:nyc:get-coverage').subscribe(({ onDone }) => queueMicrotask(() => onDone({})))
}

/** @returns {Promise<void>} */
exports.mochaGlobalSetup = async () => {
  if (configurationFirst) {
    await new Promise(resolve => { finishSetup = resolve })
    assert.strictEqual(configurationFinished, true)
  } else {
    assert.strictEqual(configurationFinished, false)
  }
  if (process.env.MOCHA_SETUP_ERROR === 'true') throw new Error('global setup failed')
  global.mochaSetupFinished = true
  process.stdout.write('GLOBAL SETUP FINISHED\n')
}

/** @returns {void} */
exports.mochaGlobalTeardown = () => {
  assert.strictEqual(global.mochaTestExecuted, true)
  process.stdout.write('GLOBAL TEARDOWN FINISHED\n')
}

if (require.main === module) {
  const MochaPackage = require('mocha')
  const Mocha = MochaPackage.default ?? MochaPackage
  const mocha = new Mocha({
    globalSetup: exports.mochaGlobalSetup,
    globalTeardown: exports.mochaGlobalTeardown,
  })
  mocha.addFile(path.join(__dirname, 'mocha-global-setup-test.js'))
  mocha.run(failures => { process.exitCode = failures ? 1 : 0 })
}
