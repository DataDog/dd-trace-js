'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

/** @returns {Promise<void>} */
exports.mochaGlobalSetup = async () => {
  if (process.env.MOCHA_SETUP_ORDER === 'configuration-first') {
    // A pending promise does not keep Node alive. Wait until startup I/O and its
    // callbacks have drained, so configuration completes before global setup.
    await new Promise(resolve => process.once('beforeExit', () => resolve()))
  }
  if (process.env.MOCHA_DISABLE_PLUGIN === 'true') {
    // Let Mocha#run initiate configuration before disabling the plugin.
    await Promise.resolve()
    require('dd-trace').use('mocha', false)
  }
  if (process.env.MOCHA_SETUP_ERROR === 'true') throw new Error('global setup failed')
  global.mochaSetupFinished = true
  process.stdout.write('GLOBAL SETUP FINISHED\n')
}

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
