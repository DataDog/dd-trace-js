'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const { NODE_MAJOR } = require('../../../version')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:aerospike:command:start')
const endCh = channel('apm:aerospike:command:end')
const errorCh = channel('apm:aerospike:command:error')

const asyncStartChannel = channel('apm:aerospike:command:asyncStart')
const asyncEndChannel = channel('apm:aerospike:command:asyncEnd')

function wrapCreateCommand (createCommand) {
  if (typeof createCommand !== 'function') return createCommand

  return function commandWithTrace () {
    const CommandClass = createCommand.apply(this, arguments)

    if (!CommandClass) return CommandClass

    shimmer.wrap(CommandClass.prototype, 'process', wrapProcess)

    return CommandClass
  }
}

function wrapProcess (process) {
  return function (...args) {
    if (typeof args[0] !== 'function') return process.apply(this, args)

    const ctx = {
      commandName: this.constructor.name,
      commandArgs: this.args,
      clientConfig: this.client.config
    }

    return startCh.runStores(ctx, () => {
      arguments[0] = function () {
        if (arguments[0] !== null) {
          ctx.error = arguments['0']
          errorCh.publish(ctx)
        }
        asyncStartChannel.runStores(ctx, () => {
          try {
            return args[0].apply(this, arguments)
          } catch (e) {
            ctx.error = e
            errorCh.publish(ctx)
          } finally {
            asyncEndChannel.publish(ctx)
          }
        })
      }
      try {
        return process.apply(this, arguments)
      } catch (e) {
        ctx.error = e
        errorCh.publish(ctx)
      } finally {
        endCh.publish(ctx)
      }
    })
  }
}

// from testing currently only works with node 20
if (NODE_MAJOR === 20) {
  addHook({ name: 'aerospike', file: 'lib/commands/command.js', versions: ['>=5.8.0'] }, commandFactory => {
    return shimmer.wrap(commandFactory, wrapCreateCommand(commandFactory))
  })
}

if (NODE_MAJOR > 14) {
  addHook({ name: 'aerospike', file: 'lib/commands/command.js', versions: ['5.5.0 - 5.7.0'] }, commandFactory => {
    return shimmer.wrap(commandFactory, wrapCreateCommand(commandFactory))
  })
}

if (NODE_MAJOR >= 14) {
  addHook({ name: 'aerospike', file: 'lib/commands/command.js', versions: ['4', '5.0.0 - 5.4.0'] }, commandFactory => {
    return shimmer.wrap(commandFactory, wrapCreateCommand(commandFactory))
  })
}
