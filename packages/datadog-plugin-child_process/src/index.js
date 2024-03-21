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
      cmdFields[i] = cmdFields[i].substring(0, 2)
      truncated = true
    }

    size += argLen
  }

  return truncated
}

class ChildProcessPlugin extends TracingPlugin {
  static get id () { return 'child_process' }
  static get prefix () { return 'tracing:datadog:child_process:execution' }

  get tracer () {
    return this._tracer
  }

  start ({ command, shell }) {
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
      service: this.config.service,
      resource: (shell === true) ? 'sh' : cmdFields[0],
      type: 'system',
      meta
    })
  }

  end ({ result, error }) {
    let exitCode

    if (result !== undefined) {
      exitCode = result?.status || 0
    } else if (error !== undefined) {
      exitCode = error?.status || error?.code || 0
    } else {
      // TracingChannels call start, end synchronously. Later when the promise is resolved then asyncStart asyncEnd.
      // Therefore in the case of calling end with neither result nor error means that they will come in the asyncEnd.
      return
    }

    this.activeSpan?.setTag('cmd.exit_code', `${exitCode}`)
    this.activeSpan?.finish()
  }

  error (error) {
    this.addError(error)
  }

  asyncEnd ({ result }) {
    this.activeSpan?.setTag('cmd.exit_code', `${result}`)
    this.activeSpan?.finish()
  }
}

module.exports = ChildProcessPlugin
