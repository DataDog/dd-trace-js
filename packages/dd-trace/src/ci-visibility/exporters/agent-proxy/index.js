'use strict'

const URL = require('url').URL

const AgentWriter = require('../../../exporters/agent/writer')
const AgentlessWriter = require('../agentless/writer')

const request = require('../../../exporters/common/request')

const log = require('../../../log')

/**
 * First it will resolve whether the Agent supports evp_proxy
 * then it will decide what writer to use.
 * Until then, it will store the traces "as is", without encoding them
 */
class AgentProxyCiVisibilityExporter {
  constructor (config) {
    this._config = config
    const { tags, url, hostname, port, prioritySampler, lookup, protocolVersion, headers } = config
    this._url = url || new URL(`http://${hostname || 'localhost'}:${port}`)
    this._timer = undefined

    this.buffer = []

    process.once('beforeExit', () => {
      if (this._writer) {
        this._writer.flush()
      }
    })

    const options = {
      path: '/info',
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      },
      protocol: this._url.protocol,
      hostname: this._url.hostname,
      port: this._url.port
    }

    request('', options, (err, res) => {
      let isErrored = false
      // if there's an error, we'll assume we can't use evp_proxy
      if (err) {
        isErrored = true
      } else {
        try {
          const {
            endpoints
          } = JSON.parse(res)
          if (endpoints.includes('/evp_proxy/v1/')) {
            this._writer = new AgentlessWriter({
              url: this._url,
              tags,
              evpProxyPrefix: '/evp_proxy/v1'
            })
          }
        } catch (e) {
          isErrored = true
        }
      }
      if (isErrored) {
        this._writer = new AgentWriter({
          url: this._url,
          prioritySampler,
          lookup,
          protocolVersion,
          headers
        })
      }
      this.exportOldTraces()
    })
  }

  exportOldTraces () {
    this.buffer.forEach(oldTrace => {
      this.export(oldTrace)
    })
    this.buffer = []
  }

  export (trace) {
    // until we know what writer to use, we just store traces
    if (!this._writer) {
      this.buffer.push(trace)
    } else {
      this._writer.append(trace)

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
  }

  setUrl (url) {
    try {
      url = new URL(url)
      this._url = url
      this._writer.setUrl(url)
    } catch (e) {
      log.error(e)
    }
  }
}

module.exports = AgentProxyCiVisibilityExporter
