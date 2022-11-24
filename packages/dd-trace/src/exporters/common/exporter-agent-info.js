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
 * Exporter that queries /info from the agent and gives you the response.
 * While this._writer is not initialized, exported traces are stored as is.
 */
class AgentInfoExporter {
  constructor (tracerConfig) {
    const { url, hostname, port } = tracerConfig
    this._url = url || new URL(format({
      protocol: 'http:',
      hostname: hostname || 'localhost',
      port
    }))
    this.traceBuffer = []
  }

  getAgentInfo (onReceivedInfo) {
    fetchAgentInfo(this._url, onReceivedInfo)
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

  export (trace) {
    // until we know what writer to use, we just store traces
    if (!this._writer) {
      this.traceBuffer.push(trace)
      return
    }

    this._export(trace)
  }

  exportUncodedTraces () {
    this.traceBuffer.forEach(oldTrace => {
      this.export(oldTrace)
    })
    this.traceBuffer = []
  }

  setUrl (url) {
    try {
      if (this._writer) {
        url = new URL(url)
        this._url = url
        this._writer.setUrl(url)
      }
    } catch (e) {
      log.error(e)
    }
  }
}

module.exports = AgentInfoExporter
