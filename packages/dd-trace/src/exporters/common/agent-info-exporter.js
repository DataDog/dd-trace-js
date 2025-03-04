const { URL, format } = require('url')

const { incrementCountMetric, TELEMETRY_EVENTS_ENQUEUED_FOR_SERIALIZATION } = require('../../ci-visibility/telemetry')
const { fetchAgentInfo } = require('./util')
const DataDogAgentDiscovery = require('../../agent_discovery/agent_discovery')

/**
 * Exporter that exposes a way to query /info endpoint from the agent and gives you the response.
 * While this._writer is not initialized, exported traces are stored as is.
 */
class AgentInfoExporter {
  constructor (tracerConfig) {
    this._config = tracerConfig
    const { url, hostname, port } = this._config
    this._url = url || new URL(format({
      protocol: 'http:',
      hostname: hostname || 'localhost',
      port
    }))
    this._traceBuffer = []
    this._isInitialized = false

    this._ddAgentDiscovery = DataDogAgentDiscovery.getInstance(this._config)
  }

  getAgentInfo (onReceivedInfoCallback) {
    this._ddAgentDiscovery.getData(onReceivedInfoCallback)
  }

  export (trace) {
    if (!this._isInitialized) {
      this._traceBuffer.push(trace)
      return
    }
    this._export(trace)
  }

  _export (payload, writer = this._writer, timerKey = '_timer') {
    if (this._config.isCiVisibility) {
      incrementCountMetric(TELEMETRY_EVENTS_ENQUEUED_FOR_SERIALIZATION, {}, payload.length)
    }
    writer.append(payload)

    const { flushInterval } = this._config

    if (flushInterval === 0) {
      writer.flush()
    } else if (flushInterval > 0 && !this[timerKey]) {
      this[timerKey] = setTimeout(() => {
        writer.flush()
        this[timerKey] = clearTimeout(this[timerKey])
      }, flushInterval).unref()
    }
  }

  getUncodedTraces () {
    return this._traceBuffer
  }

  exportUncodedTraces () {
    this.getUncodedTraces().forEach(uncodedTrace => {
      this.export(uncodedTrace)
    })
    this.resetUncodedTraces()
  }

  resetUncodedTraces () {
    this._traceBuffer = []
  }
}

module.exports = AgentInfoExporter
