'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const scrubChildProcessCmd = require('./scrub-cmd-params')

const MAX_ARG_SIZE = 4096 // 4kB

function truncateCommand (cmdFields) {
  let size = cmdFields[0].length
  let truncated = false
  for (let i = 1; i < cmdFields.length; i++) {
    if (size >= MAX_ARG_SIZE) {
      truncated = true
      cmdFields[i] = ''
      continue
    }

    const argLen = cmdFields[i].length
    if (size < MAX_ARG_SIZE && size + argLen > MAX_ARG_SIZE) {
      cmdFields[i] = cmdFields[i].slice(0, 2)
      truncated = true
    }

    size += argLen
  }

  return truncated
}

class ChildProcessPlugin extends TracingPlugin {
  static id = 'child_process'
  static prefix = 'tracing:datadog:child_process:execution'

  get tracer () {
    return this._tracer
  }

  start (ctx) {
    const { command, shell } = ctx

    if (typeof command !== 'string') {
      return
    }

    const cmdFields = scrubChildProcessCmd(command)
    const truncated = truncateCommand(cmdFields)
    const property = (shell === true) ? 'cmd.shell' : 'cmd.exec'

    const meta = {
      component: 'subprocess',
      [property]: (shell === true) ? cmdFields.join(' ') : JSON.stringify(cmdFields)
    }

    if (truncated) {
      meta['cmd.truncated'] = `${truncated}`
    }

    this.startSpan('command_execution', {
      service: this.config.service || this._tracerConfig.service,
      resource: (shell === true) ? 'sh' : cmdFields[0],
      type: 'system',
      meta
    }, ctx)

    return ctx.currentStore
  }

  end (ctx) {
    const { result, error } = ctx
    let exitCode

    if (result !== undefined) {
      exitCode = result?.status || 0
    } else if (error === undefined) {
      // TracingChannels call start, end synchronously. Later when the promise is resolved then asyncStart asyncEnd.
      // Therefore in the case of calling end with neither result nor error means that they will come in the asyncEnd.
      return
    } else {
      exitCode = error?.status || error?.code || 0
    }

    const span = ctx.currentStore?.span || this.activeSpan

    span?.setTag('cmd.exit_code', `${exitCode}`)
    span?.finish()

    return ctx.parentStore
  }

  error (ctx) {
    const { error } = ctx

    const span = ctx.currentStore?.span || this.activeSpan
    this.addError(error, span)

    return ctx.parentStore
  }

  asyncEnd (ctx) {
    const { result } = ctx

    const span = ctx.currentStore?.span || this.activeSpan

    span?.setTag('cmd.exit_code', `${result}`)
    span?.finish()

    return ctx.parentStore
  }
}

module.exports = ChildProcessPlugin
