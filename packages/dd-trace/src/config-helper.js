'use strict'

// 0. Add jira ticket for this
// 1. Adding a linter to verify that process.env is not used throughout the code (tests are fine)
// 2. Replace process.env usage with this helper
// 3. Add a file that defines the supported configurations and their aliases
// 4. Simplify config.js
// 5. Make sure config.js is loaded first, right after calling init. The order matters

const { supportedConfigurations, aliases } = require('./supported-configurations')

const configs = {}
// Round 1: assign all valid configs and backup to aliases if needed
for (const name of Object.keys(supportedConfigurations)) {
  if (name in process.env) {
    configs[name] = process.env[name]
  } else {
    for (const alias in aliases[name]) {
      if (alias in process.env) {
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
  getConfiguration (name) { //what happens if name is not in config? Is that possible?
    return configs[name]
  }
}
