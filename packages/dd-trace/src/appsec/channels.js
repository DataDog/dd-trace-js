'use strict'

const dc = require('../../../diagnostics_channel')

// TODO: use TBD naming convention
module.exports = {
  bodyParser: dc.channel('datadog:body-parser:read:finish'),
  incomingHttpRequestStart: dc.channel('dd-trace:incomingHttpRequestStart'),
  incomingHttpRequestEnd: dc.channel('dd-trace:incomingHttpRequestEnd'),
  queryParser: dc.channel('datadog:query:read:finish'),
  setCookieChannel: dc.channel('datadog:iast:set-cookie')
}
