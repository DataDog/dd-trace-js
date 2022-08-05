'use strict'

const dc = require('diagnostics_channel')
module.exports = {
  moduleLoadStart: dc.channel('dd-trace:moduleLoadStart')
}
