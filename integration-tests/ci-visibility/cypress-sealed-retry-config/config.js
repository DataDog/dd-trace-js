'use strict'

const base = require('../cypress-late-native-retries/config')

module.exports = {
  ...base,
  e2e: {
    ...base.e2e,
    async setupNodeEvents (on, config) {
      const plugin = require('dd-trace/ci/cypress/plugin')
      const result = await plugin(on, config)
      const writeMode = process.env.DD_CYPRESS_FROZEN_WRITE
      const saved = writeMode === 'nested' ? result.retries : undefined
      if (writeMode !== 'nested') result.retries = 2
      Object[process.env.DD_CYPRESS_CONFIG_LOCK || 'seal'](result)
      if (writeMode === 'strict') {
        let blocked = false
        try { result.retries = 3 } catch (error) {
          if (!(error instanceof TypeError)) throw error
          blocked = true
        }
        if (!blocked) throw new Error('frozen root assignment must throw in strict mode')
      } else if (writeMode === 'sloppy') {
        // Native non-strict assignment must be ignored, rather than throw or change the value.
        require('node:vm').runInNewContext('config.retries = 3', { config: result })
        if (result.retries !== 2) throw new Error('non-strict frozen root assignment changed retries')
      } else if (writeMode === 'nested') saved.runMode = 2
      return result
    },
  },
}
