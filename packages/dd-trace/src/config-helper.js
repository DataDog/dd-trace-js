'use strict'

// 0. Add jira ticket for this
// 1. Adding a linter to verify that process.env is not used throughout the code (tests are fine)
// 2. Replace process.env usage with this helper
// 3. Add a file that defines the supported configurations and their aliases
// 4. Simplify config.js
// 5. Make sure config.js is loaded first, right after calling init. The order matters

const { supportedConfigurations, aliases } = require('./supported-configurations')

const configs = {}
for (let name of Object.keys(process.env)) {
  // if (aliases[name]) {
  //   const identical = process.env[name] === process.env[aliases[name]]
  //   if (identical) {
  //     console.log(`Skipping ${name} because it is identical to its alias ${aliases[name]}`)
  //   } else {
  //     throw new Error(
  //       `Warning: ${name}: ${process.env[name]} is not identical to its alias ${aliases[name]}: ${process.env[aliases[name]]}`
  //     )
  //   }
  // }
  name = aliases[name] ?? name
  if (!name.startsWith('DD_') || supportedConfigurations[name]) {
    configs[name] = process.env[name]
  }
}

module.exports = {
  getConfigurations () {
    return configs
  },
  getConfiguration (name) {
    return configs[name]
  }
}
