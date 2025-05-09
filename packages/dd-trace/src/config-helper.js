'use strict'

// 0. Add jira ticket for this
// 1. Adding a linter to verify that process.env is not used throughout the code (tests are fine)
// 2. Replace process.env usage with this helper
// 3. Add a file that defines the supported configurations and their aliases
// 4. Simplify config.js
// 5. Make sure config.js is loaded first, right after calling init. The order matters

const log = require('./log')
const { supportedConfigurations, aliases } = require('./supported-configurations')

const configs = {}
// Round 1: assign all valid configs and backup to aliases if needed
for (const name of Object.keys(supportedConfigurations)) {
  if (Object.hasOwn(process.env, name) || !name.startsWith('DD_')) {
    configs[name] = process.env[name]
  } else {
    for (const alias in aliases[name]) {
      if (Object.hasOwn(process.env, alias)) {
        configs[name] = process.env[alias]
        break
      }
    }
  }
}

module.exports = {
  getConfigurations () {
    return configs
  },
  getConfiguration (name) {
    const config = configs[name]
    if (config == null) {
      log.warn(`Config ${name} was not set in process.env`)
    }
    return config
  }
}
