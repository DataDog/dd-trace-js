'use strict'

// 0. Add jira ticket for this
// 1. Adding a linter to verify that process.env is not used throughout the code (tests are fine)
// 2. Replace process.env usage with this helper
// 3. Add a file that defines the supported configurations and their aliases
// 4. Simplify config.js
// 5. Make sure config.js is loaded first, right after calling init. The order matters

const { debuglog } = require('util')
const { supportedConfigurations, aliases, deprecations } = require('./supported-configurations')
const hasOwn = Object.hasOwn || ((obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop))

const aliasString = JSON.stringify(aliases, null, 0)

const debug = debuglog('dd:debug')

let configs

// This does not work in case someone destructures process.env during loading before this file
// and the proxy is created. We need to make sure this file is loaded first.
// TODO: Guard against non-extensible/frozen process.env
function setProcessEnv (envs) {
  return new Proxy(envs, {
    // TODO: defineProperty should also be handled.
    set (target, prop, value) {
      // @ts-ignore
      target[prop] = value
      if (typeof prop === 'string' && (prop.startsWith('DD_') || prop.startsWith('OTEL_'))) {
        if (supportedConfigurations[prop]) {
          configs[prop] = value
        } else if (aliasString.includes(`"${prop}"`)) {
          for (const alias of Object.keys(aliases)) {
            // The alias should only be used if the actual configuration is not set
            if (configs[alias] === undefined && aliases[alias].includes(prop)) {
              configs[alias] = value
              break
            }
          }
        } else {
          debug(
            `Missing configuration ${prop} in supported-configurations file. The environment variable is ignored.`
          )
          throw new Error(`Missing ${prop}`)
        }
      } else {
        configs[prop] = value
      }
      return true
    },
    deleteProperty (target, prop) {
      // TODO: Improve the check
      if (aliasString.includes(`"${prop}"`) && !aliasString.includes(`"${prop}":`)) {
        for (const alias of aliases[prop]) {
          if (hasOwn(target, alias)) {
            delete target[alias]
            break
          }
        }
      } else {
        delete configs[prop]
      }
      return delete target[prop]
    }
  })
}

let envs = setProcessEnv(process.env)

function setConfigs () {
  configs = {}
  for (const [name, value] of Object.entries(envs)) {
    if (!name.startsWith('DD_') && !name.startsWith('OTEL_')) {
      configs[name] = value
    }
  }

  for (const name of Object.keys(supportedConfigurations)) {
    if (hasOwn(envs, name)) {
      configs[name] = envs[name]
    } else if (aliases[name]) {
      for (const alias of aliases[name]) {
        if (hasOwn(envs, alias)) {
          configs[name] = envs[alias]
          // TODO: Handle deprecations differently. Discuss about unifying the deprecations and logging
          if (deprecations[name]) {
            // eslint-disable-next-line no-console
            console.warn(`The configuration ${alias} is deprecated. Use ${name} instead.`)
          }
          break
        }
      }
    }
  }
}

setConfigs()

// This won't be sufficient in case the user would just call Object.defineProperty
// TODO: Use shimmer instead of the manual getter/setter replacement.
Object.defineProperty(process, 'env', {
  get () {
    return envs
  },
  set (value) {
    envs = setProcessEnv(value)
    setConfigs()
  }
})

module.exports = {
  getConfigurations () {
    return configs
  },
  getConfiguration (name) {
    const config = configs[name]
    if (config !== envs[name] &&
        (name.startsWith('DD_') || name.startsWith('OTEL_')) &&
        !hasOwn(supportedConfigurations, name) &&
        !aliasString.includes(`"${name}"`)) {
      debug(`Missing ${name} configuration in supported-configurations file. The environment variable is ignored.`)
      throw new Error(`Missing ${name}`)
    }
    return config
  }
}
