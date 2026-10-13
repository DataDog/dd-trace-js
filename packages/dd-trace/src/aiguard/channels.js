'use strict'

const dc = require('../../../../vendor/dist/dc-polyfill')

module.exports = {
  incomingHttpRequestStart: dc.channel('dd-trace:incomingHttpRequestStart'),
}
