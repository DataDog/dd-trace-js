'use strict'

const log = require('../log')

class LogExporter {
  send (queue) {
    log.JSON({ traces: queue })
  }
}

module.exports = LogExporter
