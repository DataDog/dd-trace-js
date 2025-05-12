'use strict'

// 0. Add jira ticket for this
// 1. Adding a linter to verify that process.env is not used throughout the code (tests are fine)
// 2. Replace process.env usage with this helper
// 3. Add a file that defines the supported configurations and their aliases
// 4. Simplify config.js
// 5. Make sure config.js is loaded first, right after calling init. The order matters

const { debuglog, deprecate } = require('util')
const { supportedConfigurations, aliases, deprecations } = require('./supported-configurations')

const aliasObject = {}
for (const alias of Object.keys(aliases)) {
  for (const aliasValue of aliases[alias]) {
    if (aliasObject[aliasValue]) {
      throw new Error(`The alias ${aliasValue} is already used for ${aliasObject[aliasValue]}.`)
    }
    aliasObject[aliasValue] = alias
  }
}

const deprecationMethods = {}
for (const deprecation of Object.keys(deprecations)) {
  deprecationMethods[deprecation] = deprecate(
    () => {},
    `The environment variable ${deprecation} is deprecated. Please use ${aliasObject[deprecation]} instead.`,
    `DATADOG_${deprecation}`
  )
}

const debug = debuglog('dd:debug')

module.exports = {
  getConfigurations () {
    const configs = {}
    for (const [env, value] of Object.entries(process.env)) {
      if (typeof env === 'string' && (env.startsWith('DD_') || env.startsWith('OTEL_'))) {
        if (supportedConfigurations[env]) {
          configs[env] = value
        } else if (aliasObject[env]) {
          // The alias should only be used if the actual configuration is not set
          if (process.env[aliasObject[env]] === undefined) {
            configs[aliasObject[env]] = value
          }
          // TODO(BridgeAR): Verify that this is alright with the guild
          deprecationMethods[env]?.()
        } else {
          debug(
            `Missing configuration ${env} in supported-configurations file. The environment variable is ignored.`
          )
        }
      } else {
        configs[env] = value
      }
    }
    return configs
  },
  getConfiguration (name) {
    const config = process.env[name]
    if ((name.startsWith('DD_') || name.startsWith('OTEL_')) &&
        !supportedConfigurations[name] &&
        !aliasObject[name]) {
      throw new Error(`Missing ${name} configuration in supported-configurations file.`)
    }
    if (config === undefined && aliasObject[name]) {
      for (const alias of aliases[name]) {
        if (process.env[alias] !== undefined) {
          return process.env[alias]
        }
      }
    }
    return config
  }
}
