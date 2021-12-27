'use strict'

// TODO: tags
// TODO: histogram
// TODO: actually use this

const http = require('http')
const https = require('https')

const {
  DD_API_KEY,
  DD_DD_URL = 'https://api.datadoghq.com'
} = process.env

const url = new URL(DD_DD_URL)
const client = url.protocol === 'https:' ? https : http

url.pathname = '/api/v1/series'

class Monitor {
  constructor () {
    this._gauges = {}
    this._counters = {}
    this._metrics = {}
  }

  increment (name) {
    this._gauges[name] = (this._gauges[name] || 0) + 1
  }

  decrement (name) {
    this._gauges[name] = (this._gauges[name] || 0) - 1
  }

  gauge (name, value) {
    this._gauges[name] = value
  }

  count (name) {
    this._counters[name] = (this._counters[name] || 0) + 1
  }

  write () {
    const now = Math.floor(Date.now() / 1000)

    // TODO: ensure there are no conflicts between types
    this._writeType(this._gauges, 'gauge', now)
    this._writeType(this._counters, 'count', now)

    this._gauges = {}
    this._counters = {}
  }

  flush () {
    if (Object.keys(this._metrics).length === 0) return

    const series = Object.keys(this._metrics)
      .map(metric => ({
        metric,
        points: this._metrics[metric].points,
        type: this._metrics[metric].type
      }))

    const data = JSON.stringify({ series })
    const timeout = 2000
    const options = {
      method: 'POST',
      headers: {
        'Content-Length': Buffer.byteLength(data),
        'Content-Type': 'text/json',
        'DD-Api-Key': DD_API_KEY
      },
      timeout
    }
    const req = client.request(url, options, res => {
      res.setTimeout(timeout)
      res.resume()
    })

    req.setTimeout(timeout, req.abort)
    req.write(data)

    this._metrics = {}
  }

  _writeType (map, type, time) {
    for (const name in map) {
      if (!this._metrics[name]) {
        this._metrics[name] = {
          points: [],
          type
        }
      }

      this._metrics[name].points.push([time, map[name]])
    }
  }
}

module.exports = new Monitor()
