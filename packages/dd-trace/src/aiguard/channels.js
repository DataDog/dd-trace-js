'use strict'

const dc = require('dc-polyfill')

module.exports = {
  aiguardChannel: dc.channel('dd-trace:ai:aiguard'),
  incomingHttpRequestStart: dc.channel('dd-trace:incomingHttpRequestStart'),
}
