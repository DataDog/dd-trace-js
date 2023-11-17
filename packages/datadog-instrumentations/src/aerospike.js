'use strict'

const {
  addHook
} = require('./helpers/instrument')
const { NODE_MAJOR } = require('../../../version')
const shimmer = require('../../datadog-shimmer')

const tracingChannel = require('dc-polyfill').tracingChannel
const ch = tracingChannel('apm:aerospike:command')

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
    const cb = args[0]
    if (typeof cb !== 'function') return process.apply(this, args)

    const ctx = {
      commandName: this.constructor.name,
      commandArgs: this.args,
      clientConfig: this.client.config
    }

    return ch.traceCallback(process, -1, ctx, this, ...args)
  }
}

// from testing, aerospike versions currently can't be installed on node 21
if (NODE_MAJOR === 20) {
  addHook({ name: 'aerospike', file: 'lib/commands/command.js', versions: ['>=5.8.0'] }, commandFactory => {
    return shimmer.wrap(commandFactory, wrapCreateCommand(commandFactory))
  })
}

if (NODE_MAJOR >= 15 && NODE_MAJOR <= 20) {
  addHook({ name: 'aerospike', file: 'lib/commands/command.js', versions: ['5.5.0 - 5.7.0'] }, commandFactory => {
    return shimmer.wrap(commandFactory, wrapCreateCommand(commandFactory))
  })
}

if (NODE_MAJOR >= 14 && NODE_MAJOR <= 19) {
  addHook({ name: 'aerospike', file: 'lib/commands/command.js', versions: ['4', '5.0.0 - 5.3.0'] },
    commandFactory => {
      return shimmer.wrap(commandFactory, wrapCreateCommand(commandFactory))
    })
}
