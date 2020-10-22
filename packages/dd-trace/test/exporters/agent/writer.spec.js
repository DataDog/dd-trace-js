'use strict'

const URL = require('url-parse')

function describeWriter (protocolVersion) {
  let Writer
  let writer
  let span
  let platform
  let response
  let encoder
  let url
  let prioritySampler
  let log

  beforeEach((done) => {
    span = 'formatted'

    response = JSON.stringify({
      rate_by_service: {
        'service:hello,env:test': 1
      }
    })

    platform = {
      name: sinon.stub(),
      version: sinon.stub(),
      engine: sinon.stub(),
      request: sinon.stub().yields(null, response, 200),
      msgpack: {
        prefix: sinon.stub().returns([Buffer.alloc(0)])
      }
    }

    encoder = {
      encode: sinon.stub(),
      count: sinon.stub().returns(0),
      makePayload: sinon.stub().returns([])
    }

    url = {
      protocol: 'http:',
      hostname: 'localhost',
      port: 8126
    }

    prioritySampler = {
      update: sinon.spy()
    }

    log = {
      error: sinon.spy()
    }

    const AgentEncoder = function () {
      return encoder
    }

    Writer = proxyquire('../src/exporters/agent/writer', {
      '../../encode/0.4': { AgentEncoder },
      '../../encode/0.5': { AgentEncoder },
      '../../platform': platform,
      '../../../lib/version': 'tracerVersion',
      '../../log': log
    })
    writer = new Writer({ url, prioritySampler, protocolVersion })

    process.nextTick(done)
  })

  describe('append', () => {
    it('should append a trace', () => {
      writer.append([span])

      expect(encoder.encode).to.have.been.calledWith([span])
    })
  })

  describe('flush', () => {
    it('should skip flushing if empty', () => {
      writer.flush()

      expect(encoder.makePayload).to.not.have.been.called
    })

    it('should empty the internal queue', () => {
      encoder.count.returns(1)

      writer.flush()

      expect(encoder.makePayload).to.have.been.called
    })

    it('should flush its traces to the agent', () => {
      platform.name.returns('lang')
      platform.version.returns('version')
      platform.engine.returns('interpreter')

      const expectedData = Buffer.from('prefixed')

      encoder.count.returns(2)
      encoder.makePayload.returns([expectedData])
      writer.flush()

      expect(platform.request).to.have.been.calledWithMatch({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `/v${protocolVersion}/traces`,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/msgpack',
          'Datadog-Meta-Lang': 'lang',
          'Datadog-Meta-Lang-Version': 'version',
          'Datadog-Meta-Lang-Interpreter': 'interpreter',
          'Datadog-Meta-Tracer-Version': 'tracerVersion',
          'X-Datadog-Trace-Count': '2'
        },
        data: [expectedData],
        lookup: undefined
      })
    })

    it('should log request errors', done => {
      const error = new Error('boom')

      platform.request.yields(error)

      encoder.count.returns(1)
      writer.flush()

      setTimeout(() => {
        expect(log.error).to.have.been.calledWith(error)
        done()
      })
    })

    it('should update sampling rates', () => {
      encoder.count.returns(1)
      writer.flush()

      expect(prioritySampler.update).to.have.been.calledWith({
        'service:hello,env:test': 1
      })
    })

    context('with the url as a unix socket', () => {
      beforeEach(() => {
        url = new URL('unix:/path/to/somesocket.sock')
        writer = new Writer({ url, protocolVersion })
      })

      it('should make a request to the socket', () => {
        encoder.count.returns(1)
        writer.flush()
        setImmediate(() => {
          expect(platform.request).to.have.been.calledWithMatch({
            socketPath: url.pathname
          })
        })
      })
    })

    context('with a promise url', () => {
      beforeEach(() => {
        url = Promise.resolve('http://localhost:8126')
        writer = new Writer({ url, protocolVersion })
      })
      it('should make a request to resolved url', async () => {
        encoder.count.returns(1)
        writer.flush()
        url = new URL(await url)
        expect(platform.request).to.have.been.calledWithMatch({
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port
        })
      })
    })
  })
}

describe('Writer', () => {
  describe('0.4', () => describeWriter(0.4))

  describe('0.5', () => describeWriter(0.5))
})
