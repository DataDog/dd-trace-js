'use strict'

const dc = require('diagnostics_channel')
// TODO move this file to another path, or delete and use channel directly
// TODO: use TBD naming convention
//       or directly use http plugin's channels
//       when it gets converted to new plugin system
module.exports = {
  incomingHttpRequestStart: dc.channel('dd-trace:incomingHttpRequestStart'),
  incomingHttpRequestEnd: dc.channel('dd-trace:incomingHttpRequestEnd')
}
