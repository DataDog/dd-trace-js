'use strict'

const TracingPlugin = require('../../plugins/tracing')

class ShellExecutionPlugin extends TracingPlugin {
  static get id () { return 'subprocess' }
  static get operation () { return 'resolve' }
  static get prefix () { return 'datadog:child_process:execution' }

  get tracer () {
    return this._tracer
  }

  start ({ command }) {
    const cmdFields = command.split(' ')

    this.startSpan('command_execution', {
      service: this.config.service,
      resource: cmdFields[0],
      type: 'system',
      meta: {
        component: 'subprocess',
        'cmd.exec': cmdFields
      }
    })
  }

  finish ({ ret, error }) {
    let exitCode = 0
    if (error) {
      exitCode = error.status
      this.addError(exitCode)
    }
    this.activeSpan.addTags({ 'cmd.exit_code': `${exitCode}` })
    super.finish()
  }
}

module.exports = ShellExecutionPlugin
