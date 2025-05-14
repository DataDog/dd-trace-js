'use strict'

// TODO: Add jira tickets

const { debuglog, deprecate } = require('util')
// TODO: Remove unused / outdated configurations from the supported-configurations.json file
const { supportedConfigurations, aliases, deprecations } = require('./supported-configurations.json')

const aliasToCanonical = {}
for (const canonical of Object.keys(aliases)) {
  for (const alias of aliases[canonical]) {
    if (aliasToCanonical[alias]) {
      throw new Error(`The alias ${alias} is already used for ${aliasToCanonical[alias]}.`)
    }
    aliasToCanonical[alias] = canonical
  }
}

// TODO: Consider to join deprecations with aliases by just making those entries an object.
const deprecationMethods = {}
for (const deprecation of Object.keys(deprecations)) {
  deprecationMethods[deprecation] = deprecate(
    () => {},
    `The environment variable ${deprecation} is deprecated. Please use ${aliasToCanonical[deprecation]} instead.`,
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
        } else if (aliasToCanonical[env]) {
          // The alias should only be used if the actual configuration is not set
          if (configs[aliasToCanonical[env]] === undefined) {
            // In case that more than a single alias exist, use the one defined first in our own order
            for (const alias of aliases[aliasToCanonical[env]]) {
              if (process.env[alias] !== undefined) {
                configs[aliasToCanonical[env]] = value
                break
              }
            }
          }
          deprecationMethods[env]?.()
        } else {
          throw new Error(
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
        !aliasToCanonical[name]) {
      throw new Error(`Missing ${name} configuration in supported-configurations file.`)
    }
    if (config === undefined && aliases[name]) {
      for (const alias of aliases[name]) {
        if (process.env[alias] !== undefined) {
          return process.env[alias]
        }
      }
    }
    return config
  }
}
