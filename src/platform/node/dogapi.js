'use strict'

const http = require('http')
const os = require('os')

class Client {
  constructor (options) {
    options = options || {}

    this._host = options.host || 'localhost'
    this._port = options.port || 8126
    this._prefix = options.prefix || ''
    this._tags = options.tags || []
    this._series = []
  }

  gauge (stat, value, tags) {
    const metric = this._add(stat, value, tags)

    metric.type = 'gauge'
  }

  increment (stat, value, tags) {
    const metric = this._add(stat, value, tags)

    metric.type = 'rate'
    metric.interval = 10
  }

  flush () {
    const series = this._series

    if (series.length === 0) return

    this._series = []

    const req = http.request({
      hostname: this._host,
      port: this._port,
      method: 'POST',
      path: '/v0.4/series'
    })

    req.on('error', () => {}) // swallow errors

    req.write(JSON.stringify({ series }))
    req.end()
  }

  _add (stat, value, tags) {
    tags = tags ? this._tags.concat(tags) : this._tags

    const now = Math.floor(Date.now() / 1000)
    const metric = {
      metric: `${this._prefix}${stat}`,
      points: [[now, value]],
      tags,
      host: os.hostname()
    }

    this._series.push(metric)

    return metric
  }
}

module.exports = Client
