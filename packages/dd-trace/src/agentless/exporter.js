"use strict";

const log = require('../log')

class LogExporter {
  constructor() { }

  send(queue) {
    log.JSON({ traces: queue })
  }
}

module.exports = LogExporter
