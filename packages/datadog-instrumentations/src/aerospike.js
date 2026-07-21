'use strict'

const tracingChannel = require('dc-polyfill').tracingChannel

const shimmer = require('../../datadog-shimmer')
const {
  addHook,
} = require('./helpers/instrument')

const ch = tracingChannel('apm:aerospike:command')
const kTracingCallbackCommand = Symbol('datadog.aerospike.tracing_callback_command')

function wrapCreateCommand (createCommand) {
  if (typeof createCommand !== 'function') return createCommand

  return function commandWithTrace (...args) {
    const CommandClass = createCommand.apply(this, args)

    if (!CommandClass) return CommandClass

    if (typeof CommandClass.prototype.executeWithCallback === 'function') {
      shimmer.wrap(CommandClass.prototype, 'executeWithCallback', wrapExecuteWithCallback)
    }
    shimmer.wrap(CommandClass.prototype, 'process', wrapProcess)

    return CommandClass
  }
}

function wrapExecuteWithCallback (executeWithCallback) {
  return function (...args) {
    const cb = args[0]
    if (typeof cb !== 'function') return executeWithCallback.apply(this, args)

    this[kTracingCallbackCommand] = true
    try {
      return ch.traceCallback(executeWithCallback, 0, getContext(this), this, ...args)
    } finally {
      this[kTracingCallbackCommand] = false
    }
  }
}

function wrapProcess (process) {
  return function (...args) {
    const cb = args[0]
    if (typeof cb !== 'function') return process.apply(this, args)

    if (this[kTracingCallbackCommand]) return process.apply(this, args)

    const ctx = getContext(this)

    return ch.traceCallback(process, -1, ctx, this, ...args)
  }
}

function getContext (command) {
  return {
    commandName: command.constructor.name,
    commandArgs: command.args,
    clientConfig: command.client.config,
  }
}

addHook({
  name: 'aerospike',
  file: 'lib/commands/command.js',
  versions: ['>=4'],
},
commandFactory => {
  return shimmer.wrapFunction(commandFactory, f => wrapCreateCommand(f))
})
