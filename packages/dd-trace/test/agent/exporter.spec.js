'use strict'

const URL = require('url-parse')

describe('AgentExporter', () => {
  let AgentExporter
  let exporter
  let prioritySampler
  let platform
  let response
  let url
  let log

  beforeEach(() => {
    response = JSON.stringify({
      rate_by_service: {
        'service:hello,env:test': 1
      }
    })

    platform = {
      name: sinon.stub(),
      version: sinon.stub(),
      engine: sinon.stub(),
      request: sinon.stub().yields(null, response),
      msgpack: {
        prefix: sinon.stub()
      }
    }
    url = {
      protocol: 'http:',
      hostname: 'localhost',
      port: 8126
    }

    log = {
      error: sinon.spy()
    }

    prioritySampler = {
      update: sinon.stub(),
      sample: sinon.stub()
    }

    AgentExporter = proxyquire('../src/agent/exporter', {
      '../platform': platform,
      '../log': log,
      '../../lib/version': 'tracerVersion'
    })
    exporter = new AgentExporter(prioritySampler, url)
  })
  describe('send', () => {
    it('should send traces to the agent', () => {
      platform.msgpack.prefix.withArgs(['encoded', 'encoded']).returns('prefixed')
      platform.name.returns('lang')
      platform.version.returns('version')
      platform.engine.returns('interpreter')

      const queue = ['encoded', 'encoded']
      exporter.send(queue)

      expect(platform.request).to.have.been.calledWithMatch({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: '/v0.4/traces',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/msgpack',
          'Datadog-Meta-Lang': 'lang',
          'Datadog-Meta-Lang-Version': 'version',
          'Datadog-Meta-Lang-Interpreter': 'interpreter',
          'Datadog-Meta-Tracer-Version': 'tracerVersion',
          'X-Datadog-Trace-Count': '2'
        },
        data: 'prefixed'
      })
    })

    it('should log request errors', done => {
      const error = new Error('boom')

      platform.request.yields(error)
      const queue = ['encoded']
      exporter.send(queue)

      setTimeout(() => {
        expect(log.error).to.have.been.calledWith(error)
        done()
      })
    })

    context('with the url as a unix socket', () => {
      beforeEach(() => {
        url = new URL('unix:/path/to/somesocket.sock')
        exporter = new AgentExporter(prioritySampler, url)
      })

      it('should make a request to the socket', () => {
        const queue = ['encoded']
        exporter.send(queue)

        expect(platform.request).to.have.been.calledWithMatch({
          socketPath: url.pathname
        })
      })
    })
  })
})
