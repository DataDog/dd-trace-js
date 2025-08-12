'use strict'

/* eslint-disable eslint-rules/eslint-process-env */

const { deprecate } = require('util')
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

const deprecationMethods = {}
for (const deprecation of Object.keys(deprecations)) {
  deprecationMethods[deprecation] = deprecate(
    () => {},
    `The environment variable ${deprecation} is deprecated.` +
    (aliasToCanonical[deprecation]
      ? ` Please use ${aliasToCanonical[deprecation]} instead.`
      : ` ${deprecations[deprecation]}`),
    `DATADOG_${deprecation}`
  )
}

module.exports = {
  /**
   * Returns the environment variables that are supported by the tracer
   * (including all non-Datadog/OTEL specific environment variables)
   *
   * @returns {Partial<process.env>} The environment variables
   */
  getEnvironmentVariables () {
    const configs = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('DD_') || key.startsWith('OTEL_') || aliasToCanonical[key]) {
        if (supportedConfigurations[key]) {
          configs[key] = value
        } else if (aliasToCanonical[key] && configs[aliasToCanonical[key]] === undefined) {
          // The alias should only be used if the actual configuration is not set
          // In case that more than a single alias exist, use the one defined first in our own order
          for (const alias of aliases[aliasToCanonical[key]]) {
            if (process.env[alias] !== undefined) {
              configs[aliasToCanonical[key]] = value
              break
            }
          }
        // TODO(BridgeAR) Implement logging. It would have to use a timeout to
        // lazily log the message after all loading being done otherwise.
        //   debug(
        //     `Missing configuration ${env} in supported-configurations file. The environment variable is ignored.`
        //   )
        }
        deprecationMethods[key]?.()
      } else {
        configs[key] = value
      }
    }
    return configs
  },

  /**
   * Returns the environment variable, if it's supported or a non Datadog
   * configuration. Otherwise, it throws an error.
   *
   * @param {string} name Environment variable name
   * @returns {string|undefined}
   * @throws {Error} if the configuration is not supported
   */
  getEnvironmentVariable (name) {
    if ((name.startsWith('DD_') || name.startsWith('OTEL_') || aliasToCanonical[name]) &&
        !supportedConfigurations[name]) {
      throw new Error(`Missing ${name} env/configuration in "supported-configurations.json" file.`)
    }
    const config = process.env[name]
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
