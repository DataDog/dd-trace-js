'use strict'

// 0. Add jira ticket for this
// 1. Adding a linter to verify that process.env is not used throughout the code (tests are fine)
// 2. Replace process.env usage with this helper
// 3. Add a file that defines the supported configurations and their aliases
// 4. Simplify config.js
// 5. Make sure config.js is loaded first, right after calling init. The order matters

const log = require('./log')
const { supportedConfigurations, aliases } = require('./supported-configurations')
const hasOwn = Object.hasOwn || ((obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop))

const configs = {}
// Round 1: assign all valid configs and backup to aliases if needed
for (const [name, value] of Object.entries(process.env)) {
  if (!name.startsWith('DD_')) {
    configs[name] = value
  }
}

for (const name of Object.keys(supportedConfigurations)) {
  if (process.env[name]) {
    configs[name] = process.env[name]
  } else {
    for (const alias of aliases[name]) {
      if (process.env[alias]) {
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
    if (config === undefined && !hasOwn(supportedConfigurations, name)) {
      log.debug(`Missing ${name} configuration in supported-configurations fi le. The environment variable is ignored.`)
    }
    return config
  }
}
