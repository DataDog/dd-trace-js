'use strict'

const dc = require('dc-polyfill')

module.exports = {
  incomingHttpRequestStart: dc.channel('dd-trace:incomingHttpRequestStart'),
  openaiRequestEvaluate: dc.channel('apm:openai:request:evaluate'),
  vercelAiEvaluate: dc.channel('dd-trace:vercel-ai:evaluate'),
}
