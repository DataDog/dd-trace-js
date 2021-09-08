'use strict'

const dc = require('./dc')

module.exports = {
  INCOMING_HTTP_REQUEST_START: dc.channel('dd-trace:INCOMING_HTTP_REQUEST_START'),
  INCOMING_HTTP_REQUEST_END: dc.channel('dd-trace:INCOMING_HTTP_REQUEST_END')
}
