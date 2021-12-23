'use strict'

const dc = require('diagnostics_channel')

module.exports = {
  incomingHttpRequestStart: dc.channel('dd-trace:incomingHttpRequestStart'),
  incomingHttpRequestEnd: dc.channel('dd-trace:incomingHttpRequestEnd')
}
