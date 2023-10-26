'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const scrubChildProcessCmd = require('./scrub-cmd-params')

const MAX_ARG_SIZE = 32000 // 4kB

function truncateCommand (cmdFields) {
  let size = cmdFields[0].length
  let limit = false
  for (let i = 1; i < cmdFields.length; i++) {
    size += cmdFields[i].length
    if (size >= MAX_ARG_SIZE && !limit) {
      cmdFields[i] = cmdFields[i].substring(0, 2)
      limit = true
      continue
    }

    if (limit) {
      cmdFields[i] = ''
    }
  }
}

class ChildProcessPlugin extends TracingPlugin {
  static get id () { return 'child_process' }
  static get prefix () { return 'datadog:child_process:execution' }

  get tracer () {
    return this._tracer
  }

  start ({ command, shell }) {
    if (typeof command !== 'string') {
      return
    }

    const cmdFields = scrubChildProcessCmd(command)
    truncateCommand(cmdFields)

    const property = (shell === true) ? 'cmd.shell' : 'cmd.exec'

    this.startSpan('command_execution', {
      service: this.config.service,
      resource: cmdFields[0],
      type: 'system',
      meta: {
        'component': 'subprocess',
        [property]: JSON.stringify(cmdFields)
      }
    })
  }

  finish ({ exitCode }) {
    this.activeSpan.setTag('cmd.exit_code', `${exitCode}`)
    super.finish()
  }
}

module.exports = ChildProcessPlugin
