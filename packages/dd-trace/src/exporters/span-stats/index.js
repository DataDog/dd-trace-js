const { URL, format } = require('url')

const { Writer } = require('./writer')

class SpanStatsExporter {
  constructor (config) {
    const { hostname = '127.0.0.1', port = 8126, tags, url } = config
    this._url = url || new URL(format({
      protocol: 'http:',
      hostname: hostname || 'localhost',
      port
    }))
    this._writer = new Writer({ url: this._url, tags })
  }

  export (payload) {
    this._writer.append(payload)
    this._writer.flush()
  }
}

module.exports = {
  SpanStatsExporter
}
