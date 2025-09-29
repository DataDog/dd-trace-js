'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { tracingChannel } = require('dc-polyfill')
const path = require('path')
const fs = require('fs')

function createWrapper (channelName, operator) {
  const channel = tracingChannel(channelName)

  return function (original) {
    return function (...args) {
      if (!channel.start.hasSubscribers) {
        return original.apply(this, args)
      }

      const ctx = {
        self: this,
        arguments: args
      }

      if (operator === 'tracePromise') {
        return channel.tracePromise(original, ctx, this, ...args)
      } else if (operator === 'traceSync') {
        return channel.traceSync(original, ctx, this, ...args)
      }
      return original.apply(this, args)
    }
  }
}

function createEventWrapper (channelName, config) {
  const channel = tracingChannel(channelName)

  return function (original) {
    return function (...args) {
      const ctx = {
        this: this,
        args
      }

      const callback = args[args.length - 1]
      const eventName = args[args.length - 2]

      if (typeof callback !== 'function') {
        return original.apply(this, args)
      }

      // Only wrap if the event name matches (or if no specific events are listed)
      if (eventName !== 'completed') {
        return original.apply(this, args)
      }

      return channel.traceCallback(original, -1, ctx, this, ...args)
    }
  }
}

function createDeclarativeInstrumentation (integrationName) {
  const integrationJsonPath = path.resolve(
    __dirname, `../../datadog-plugin-${integrationName}/src/${integrationName}.analysis.json`
  )

  let analysis
  try {
    analysis = JSON.parse(fs.readFileSync(integrationJsonPath, 'utf8'))
  } catch (e) {
    console.error(`[Declarative] Failed to load integration.json from ${integrationJsonPath}`, e)
    return
  }

  const { orchestrion_config: orchestrionConfig } = analysis
  if (!orchestrionConfig || !orchestrionConfig.instrumentations) {
    console.error('[Declarative] No orchestrion_config.instrumentations found in analysis.')
    return
  }

  // Group instrumentations by their factory method to handle nesting
  const instrumentationsByFactory = orchestrionConfig.instrumentations.reduce((acc, instr) => {
    const factoryKey = instr.factory ? `${instr.factory.class}#${instr.factory.method}` : 'direct'
    if (!acc[factoryKey]) {
      acc[factoryKey] = {
        factory: instr.factory,
        targets: []
      }
    }
    acc[factoryKey].targets.push(instr)
    return acc
  }, {})

  for (const key in instrumentationsByFactory) {
    const { factory, targets } = instrumentationsByFactory[key]

    if (factory) {
      // This is a factory pattern. We need to wrap the factory method first.
      const factoryTarget = targets[0] // factory info is the same for all targets
      addHook({ name: factoryTarget.module_name, versions: [factoryTarget.version_range || '*'] }, (exports) => {
        const FactoryClass = exports[factory.class] || (exports.default && exports.default[factory.class]) || exports.default || exports
        if (FactoryClass && FactoryClass.prototype && FactoryClass.prototype[factory.method]) {
          shimmer.wrap(FactoryClass.prototype, factory.method, original => {
            return async function (...args) {
              const returnedInstance = await original.apply(this, args)

              // Now, wrap the methods on the returned instance
              for (const target of targets) {
                const { function_query: tq, channel_name: cn, operator: op } = target
                if (returnedInstance && returnedInstance[tq.name]) {
                  const wrapper = createWrapper(cn, op)
                  shimmer.wrap(returnedInstance, tq.name, wrapper)
                }
              }
              return returnedInstance
            }
          })
        } else {
          console.warn(`[Declarative] Could not find factory method ${factory.class}.${factory.method} to patch.`)
        }
        return exports
      })
    } else {
      // This is a direct instrumentation pattern (no factory)
      for (const instr of targets) {
        const {
          module_name: moduleName,
          file_path: filePath,
          version_range: versionRange,
          function_query: functionQuery,
          channel_name: channelName,
          operator
        } = instr

        const { name: methodName, class: className } = functionQuery

        addHook({ name: moduleName, file: filePath, versions: [versionRange || '*'] }, (exports) => {
          const PatchedClass = exports.default || exports[className] || exports
          if (PatchedClass && PatchedClass.prototype && PatchedClass.prototype[methodName]) {
            let wrapper
            wrapper = operator === 'wrapCallback' ? createEventWrapper(channelName, instr) : createWrapper(channelName, operator)
            shimmer.wrap(PatchedClass.prototype, methodName, wrapper)
          } else {
            console.warn(`[Declarative] Could not find ${className}.${methodName} to patch in ${moduleName}.`)
          }
          return exports
        })
      }
    }
  }
}

module.exports = { createDeclarativeInstrumentation }
