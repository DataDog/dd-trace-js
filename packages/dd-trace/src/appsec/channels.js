'use strict'

const dc = require('../../../diagnostics_channel')

// TODO: use TBD naming convention
module.exports = {
  incomingHttpRequestStart: dc.channel('dd-trace:incomingHttpRequestStart'),
  incomingHttpRequestEnd: dc.channel('dd-trace:incomingHttpRequestEnd'),
  bodyParser: dc.channel('datadog:body-parser:read:finish'),
  queryParser: dc.channel('datadog:query:read:finish')
}
