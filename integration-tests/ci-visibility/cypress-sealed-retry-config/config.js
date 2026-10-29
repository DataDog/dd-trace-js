'use strict'

const base = require('../cypress-late-native-retries/config')

module.exports = {
  ...base,
  e2e: {
    ...base.e2e,
    async setupNodeEvents (on, config) {
      const plugin = require('dd-trace/ci/cypress/plugin')
      const result = await plugin(on, config)
      result.retries = 2
      Object[process.env.DD_CYPRESS_CONFIG_LOCK || 'seal'](result)
      return result
    },
  },
}
