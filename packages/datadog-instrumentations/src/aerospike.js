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

const versions = (() => {
  switch (process.versions.node.split('.')[0]) {
    case '16':
      return ['>=4 <5.2.0']
    case '18':
      return ['5.2.0 - 5.7.0']
    case '20':
      return ['>=5.8.0']
    default:
      return []
  }
})()

addHook({
  name: 'aerospike',
  file: 'lib/commands/command.js',
  versions
},
commandFactory => {
  return shimmer.wrapFunction(commandFactory, f => wrapCreateCommand(f))
})
