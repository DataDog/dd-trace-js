'use strict'

const AgentExporter = require('./exporters/agent')
const LogExporter = require('./exporters/log')
const JaegerExporter = require('./exporters/jaeger')
const exporters = require('../../../ext/exporters')

module.exports = (name) => {
  switch (name) {
    case exporters.JAEGER:
      return JaegerExporter
    case exporters.LOG:
      return LogExporter
    case exporters.AGENT:
      return AgentExporter
    default:
      return JaegerExporter
  }
}
