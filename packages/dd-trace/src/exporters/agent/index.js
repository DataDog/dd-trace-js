'use strict'

const { URL, format } = require('url')
const log = require('../../log')
const Writer = require('./writer')
const DataDogAgentDiscovery = require('../../agent_discovery/agent_discovery')

class AgentExporter {
  constructor (config, prioritySampler) {
    this._config = config
    const { url, hostname, port, lookup, protocolVersion, stats = {}, apmTracingEnabled } = config
    this._url = url || new URL(format({
      protocol: 'http:',
      hostname: hostname || 'localhost',
      port
    }))

    this.agentSupportsTopLevelSpanEvents = false

    const ddAgentDiscovery = DataDogAgentDiscovery.getInstance(this._config)
    ddAgentDiscovery.registerCallback(
      (err, agentInfo) => {
        if (err) {
          this.agentSupportsTopLevelSpanEvents = false
        } else {
          this.agentSupportsTopLevelSpanEvents = agentInfo?.span_events === true
        }
    })

    const headers = {}
    if (stats.enabled || apmTracingEnabled === false) {
      headers['Datadog-Client-Computed-Stats'] = 'yes'
    }

    this._writer = new Writer({
      url: this._url,
      prioritySampler,
      lookup,
      protocolVersion,
      headers
    })

    this._timer = undefined
    process.once('beforeExit', () => this._writer.flush())
  }

  setUrl (url) {
    try {
      url = new URL(url)
      this._url = url
      this._writer.setUrl(url)
    } catch (e) {
      log.warn(e.stack)
    }
  }

  export (spans) {
    this._writer.append(spans)

    const { flushInterval } = this._config

    if (flushInterval === 0) {
      this._writer.flush()
    } else if (flushInterval > 0 && !this._timer) {
      this._timer = setTimeout(() => {
        this._writer.flush()
        this._timer = clearTimeout(this._timer)
      }, flushInterval).unref()
    }
  }

  flush (done = () => {}) {
    this._writer.flush(done)
  }
}

module.exports = AgentExporter
