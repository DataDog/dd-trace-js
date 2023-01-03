const { URL, format } = require('url')

const request = require('./request')
const log = require('../../log')

function fetchAgentInfo (url, callback) {
  request('', {
    path: '/info',
    url
  }, (err, res) => {
    if (err) {
      return callback(err)
    }
    try {
      const response = JSON.parse(res)
      return callback(null, response)
    } catch (e) {
      return callback(e)
    }
  })
}

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
  }

  getAgentInfo (onReceivedInfo) {
    fetchAgentInfo(this._url, onReceivedInfo)
  }

  export (trace) {
    if (!this._isInitialized) {
      this._traceBuffer.push(trace)
      return
    }
    this._export(trace)
  }

  _export (payload, writer = this._writer, timerKey = '_timer') {
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

  resetUncodedTraces () {
    this._traceBuffer = []
  }

  setUrl (url) {
    url = new URL(url)
    this._url = url
    try {
      this._writer.setUrl(url)
    } catch (e) {
      log.error(e)
    }
  }
}

module.exports = AgentInfoExporter
