'use strict'

const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')

const {
  setRumTestCorrelation,
  TEST_BROWSER_DRIVER,
  TEST_BROWSER_DRIVER_VERSION,
  TEST_BROWSER_NAME,
  TEST_TYPE,
} = require('../../dd-trace/src/plugins/util/test')

class SeleniumPlugin extends CiPlugin {
  static id = 'selenium'

  constructor (...args) {
    super(...args)

    this.addSub('ci:selenium:driver:get', (ctx) => {
      const { seleniumVersion, browserName } = ctx
      const activeSpan = storage('legacy').getStore()?.span
      const testSpan = setRumTestCorrelation(ctx, activeSpan)
      if (!testSpan) {
        return
      }
      testSpan.setTag(TEST_BROWSER_DRIVER, 'selenium')
      testSpan.setTag(TEST_BROWSER_DRIVER_VERSION, seleniumVersion)
      testSpan.setTag(TEST_BROWSER_NAME, browserName)
      testSpan.setTag(TEST_TYPE, 'browser')
    })
  }
}

module.exports = SeleniumPlugin
