'use strict'

const dc = require('../../../../diagnostics_channel')

// TODO: use TBD naming convention
module.exports = {
  incomingHttpRequestStart: dc.channel('dd-trace:incomingHttpRequestStart'),
  incomingHttpRequestEnd: dc.channel('dd-trace:incomingHttpRequestEnd')
}
