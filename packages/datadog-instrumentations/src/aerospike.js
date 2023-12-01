'use strict'

const {
  addHook
} = require('./helpers/instrument')
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

addHook({
  name: 'aerospike',
  file: 'lib/commands/command.js',
  versions: ['^3.16.2', '4', '5']
},
commandFactory => {
  return shimmer.wrap(commandFactory, wrapCreateCommand(commandFactory))
})
