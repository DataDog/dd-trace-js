'use strict'

// 0. Add jira ticket for this
// 1. Adding a linter to verify that process.env is not used throughout the code (tests are fine)
// 2. Replace process.env usage with this helper
// 3. Add a file that defines the supported configurations and their aliases
// 4. Simplify config.js
// 5. Make sure config.js is loaded first, right after calling init. The order matters

const { debuglog } = require('util')
const { supportedConfigurations, aliases } = require('./supported-configurations')
const hasOwn = Object.hasOwn || ((obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop))

const aliasString = JSON.stringify(aliases, null, 0)

const debug = debuglog('dd:debug')

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
  } else if (aliases[name]) {
    for (const alias of aliases[name]) {
      if (process.env[alias]) {
        configs[name] = process.env[alias]
        break
      }
    }
  }
}

// This does not work in case someone destructures process.env during loading before this file
// and the proxy is created. We need to make sure this file is loaded first.
process.env = new Proxy(process.env, {
  // TODO: defineProperty should also be handled.
  set (target, prop, value) {
    // @ts-ignore
    target[prop] = value
    if (typeof prop === 'string' && prop.startsWith('DD_')) {
      if (supportedConfigurations[prop]) {
        configs[prop] = value
      } else if (aliasString.includes(`"${prop}"`)) {
        for (const alias of Object.keys(aliases)) {
          if (aliases[alias].includes(prop)) {
            configs[alias] = value
            break
          }
        }
      } else {
        debug(`Missing configuration ${prop} in supported-configurations file. The environment variable is ignored.`)
        console.error(`Missing ${prop}`)
      }
    } else {
      configs[prop] = value
    }
    return true
  }
})

module.exports = {
  getConfigurations () {
    return configs
  },
  getConfiguration (name) {
    const config = configs[name]
    if (config === undefined &&
        name.startsWith('DD_') &&
        !hasOwn(supportedConfigurations, name) &&
        !aliasString.includes(`"${name}"`)) {
      debug(`Missing ${name} configuration in supported-configurations file. The environment variable is ignored.`)
      console.error(`Missing ${name}`)
    }
    return config
  }
}
