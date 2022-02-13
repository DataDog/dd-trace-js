'use strict'

const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')

class PinoPlugin extends LogPlugin {
  static get name () {
    return 'pino'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:pino:log:after', ({ logMessage }) => {
      if (logMessage && logMessage.dd) {
        delete logMessage.dd
      }
    })
  }
}

module.exports = PinoPlugin
