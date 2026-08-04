'use strict'

const dc = require('dc-polyfill')

module.exports = {
  incomingHttpRequestStart: dc.channel('dd-trace:incomingHttpRequestStart'),
}
