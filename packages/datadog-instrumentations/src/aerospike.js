'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
// const tracingChannel = require('dc-polyfill').tracingChannel
// const ch = tracingChannel('apm:aerospike:command')
const { NODE_MAJOR, NODE_MINOR } = require('../../../version')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:aerospike:query:start')
const endCh = channel('apm:aerospike:query:end') // you need return value of function your instrumenting
const errorCh = channel('apm:aerospike:query:error')

const asyncStartChannel = channel('apm:aerospike:query:asyncStart') // write before async call back gets called, thus in our case finishing the span
const asyncEndChannel = channel('apm:aerospike:query:asyncEnd') // you need async return value of function your instrumenting

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

    // return ch.traceCallback(process, -1, ctx, this, ...args)
    return startCh.runStores(ctx, () => {
      arguments[0] = function () {
        if (arguments[0] !== null) {
          ctx.error = arguments['0']
          errorCh.publish(ctx)
        }
        asyncStartChannel.runStores(ctx, () => {
          try {
            // console.log(55, args)
            const res = args[0].apply(this, arguments)
            // console.log(55, res, arguments)
            return res
          } catch (e) {
            ctx.error = e
            errorCh.publish(ctx)
          } finally {
            asyncEndChannel.publish(ctx)
          }
        })
      }
      try {
        const res = process.apply(this, arguments)
        return res
      } catch (e) {
        ctx.error = e
        errorCh.publish(ctx)
      } finally {
        endCh.publish(ctx)
      }
    })
  }
}

// addHook({ name: 'aerospike', file: 'lib/commands/command.js', versions: ['3', '4', '>=5'] }, commandFactory => {
//   return shimmer.wrap(commandFactory, wrapCreateCommand(commandFactory))
// })

if (NODE_MAJOR >= 20) {
  addHook({ name: 'aerospike', file: 'lib/commands/command.js', versions: ['>=5.8.0'] }, commandFactory => {
    return shimmer.wrap(commandFactory, wrapCreateCommand(commandFactory))
  })
}

if (NODE_MAJOR >= 16 && NODE_MAJOR < 20) {
  addHook({ name: 'aerospike', file: 'lib/commands/command.js', versions: ['5.5.0'] }, commandFactory => {
    return shimmer.wrap(commandFactory, wrapCreateCommand(commandFactory))
  })
}

if (NODE_MAJOR === 14) {
  addHook({ name: 'aerospike', file: 'lib/commands/command.js', versions: ['5.2.0'] }, commandFactory => {
    return shimmer.wrap(commandFactory, wrapCreateCommand(commandFactory))
  })
}
