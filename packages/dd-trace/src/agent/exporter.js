'use strict'

const log = require('../log')
const platform = require('../platform')
const tracerVersion = require('../../lib/version')

class AgentExporter {
  constructor (prioritySampler, url) {
    this._prioritySampler = prioritySampler
    this._url = url
  }

  send (queue) {
    const data = platform.msgpack.prefix(queue)
    const count = queue.length

    const options = {
      path: '/v0.4/traces',
      method: 'PUT',
      headers: {
        'Content-Type': 'application/msgpack',
        'Datadog-Meta-Lang': platform.name(),
        'Datadog-Meta-Lang-Version': platform.version(),
        'Datadog-Meta-Lang-Interpreter': platform.engine(),
        'Datadog-Meta-Tracer-Version': tracerVersion,
        'X-Datadog-Trace-Count': String(count)
      }
    }

    if (this._url.protocol === 'unix:') {
      options.socketPath = this._url.pathname
    } else {
      options.protocol = this._url.protocol
      options.hostname = this._url.hostname
      options.port = this._url.port
    }

    log.debug(() => `Request to the agent: ${JSON.stringify(options)}`)

    platform.request(Object.assign({ data }, options), (err, res) => {
      if (err) return log.error(err)

      log.debug(`Response from the agent: ${res}`)

      try {
        this._prioritySampler.update(JSON.parse(res).rate_by_service)
      } catch (e) {
        log.error(err)
      }
    })
  }
}

module.exports = AgentExporter
