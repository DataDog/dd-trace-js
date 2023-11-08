'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const tracingChannel = require('dc')
const shimmer = require('../../datadog-shimmer')
const ch = channel('apm:aerospike:command:start')

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
  return function (cb) {
    if (typeof cb !== 'function') return process.apply(this, arguments)

    const ctx = {
      commandName: this.constructor.name,
      commandArgs: this.args,
      clientConfig: this.client.config
    }

    // return startCh.runStores(ctx, () => {
    //   arguments[0] = function () {
    //     asyncStartChannel.runStores(ctx, () => {
    //       try {
    //         return cb.apply(this, arguments)
    //       } catch (e) {
    //         ctx.error = e
    //         errorCh.publish(ctx)
    //       } finally {
    //         asyncEndChannel.publish(ctx)
    //       }
    //     })
    //   }
    //   try {
    //     return process.apply(this, arguments)
    //   } catch (e) {
    //     ctx.error = e
    //     errorCh.publish(ctx)
    //   } finally {
    //     endCh.publish(ctx)
    //   }
    // })

    return traceSync(fn, context = {}, thisArg, ...args) {
      const { start, end, error } = this;
  
      return start.runStores(context, () => {
        try {
          const result = ReflectApply(fn, thisArg, args);
          context.result = result;
          return result;
        } catch (err) {
          context.error = err;
          error.publish(context);
          throw err;
        } finally {
          end.publish(context);
        }
      });
    }
  }
}

addHook({ name: 'aerospike', file: 'lib/commands/command.js', versions: ['>=5'] }, commandFactory => {
  return shimmer.wrap(commandFactory, wrapCreateCommand(commandFactory))
})
