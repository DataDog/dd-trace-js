'use strict'

const TracingPlugin = require('../../plugins/tracing')
const scrubChildProcessCmd = require('./scrub_cmd_params')

class ChildProcessPlugin extends TracingPlugin {
  static get id () { return 'subprocess' }
  static get prefix () { return 'datadog:child_process:execution' }

  get tracer () {
    return this._tracer
  }

  start ({ command }) {
    if (typeof command !== 'string') {
      return
    }

    const cmdFields = scrubChildProcessCmd(command)

    this.startSpan('command_execution', {
      service: this.config.service,
      resource: cmdFields[0],
      type: 'system',
      meta: {
        'component': 'subprocess',
        'cmd.exec': cmdFields,
        'customMeta': 15
      }
    })
  }

  finish ({ exitCode }) {
    this.activeSpan.setTag('cmd.exit_code', `${exitCode}`)
    super.finish()
  }
}

module.exports = ChildProcessPlugin
