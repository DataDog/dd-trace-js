'use strict'

const URL = require('url').URL

const AgentWriter = require('../../../exporters/agent/writer')
const AgentlessWriter = require('../agentless/writer')
const CoverageWriter = require('../agentless/coverage-writer')

const request = require('../../../exporters/common/request')

const log = require('../../../log')

const AGENT_EVP_PROXY_PATH = '/evp_proxy/v2'
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

    this.traceBuffer = []
    this.coverageBuffer = []

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
      let isEvpCompatible = true
      // if there's an error, we'll assume we can't use evp_proxy
      if (err) {
        isEvpCompatible = false
      } else {
        try {
          const {
            endpoints
          } = JSON.parse(res)
          if (endpoints.some(url => url.includes(AGENT_EVP_PROXY_PATH))) {
            this._writer = new AgentlessWriter({
              url: this._url,
              tags,
              evpProxyPrefix: AGENT_EVP_PROXY_PATH
            })
            this._coverageWriter = new CoverageWriter({
              url: this._url,
              evpProxyPrefix: AGENT_EVP_PROXY_PATH
            })
            this.exportOldTraces()
            this.exportOldCoverages()
          } else {
            isEvpCompatible = false
          }
        } catch (e) {
          isEvpCompatible = false
        }
      }
      if (!isEvpCompatible) {
        this._writer = new AgentWriter({
          url: this._url, // not quite?
          prioritySampler,
          lookup,
          protocolVersion,
          headers
        })
        // coverages will never be used, so we discard them
        this.coverageBuffer = []
        this.exportOldTraces()
      }
    })
  }

  exportOldTraces () {
    this.traceBuffer.forEach(oldTrace => {
      this.export(oldTrace)
    })
    this.traceBuffer = []
  }

  exportOldCoverages () {
    this.coverageBuffer.forEach(oldCoveragePayload => {
      this.exportCoverage(oldCoveragePayload)
    })
    this.coverageBuffer = []
  }

  exportCoverage ({ span, coverageFiles }) {
    // until we know what writer to use, we just store coverage payloads
    if (!this._coverageWriter) {
      this.coverageBuffer.push({ span, coverageFiles })
      return
    }
    const formattedCoverage = {
      traceId: span.context()._traceId,
      spanId: span.context()._spanId,
      files: coverageFiles
    }

    this._coverageWriter.append(formattedCoverage)

    const { flushInterval } = this._config

    if (flushInterval === 0) {
      this._coverageWriter.flush()
    } else if (flushInterval > 0 && !this._coverageTimer) {
      this._coverageTimer = setTimeout(() => {
        this._coverageWriter.flush()
        this._coverageTimer = clearTimeout(this._coverageTimer)
      }, flushInterval).unref()
    }
  }

  export (trace) {
    // until we know what writer to use, we just store traces
    if (!this._writer) {
      this.traceBuffer.push(trace)
      return
    }

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
