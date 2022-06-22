'use strict'

const { expect } = require('chai')

const URL = require('url').URL

function describeWriter (protocolVersion) {
  let Writer
  let writer
  let span
  let request
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

    request = sinon.stub().yieldsAsync(null, response, 200)

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
      '../common/request': request,
      '../../encode/0.4': { AgentEncoder },
      '../../encode/0.5': { AgentEncoder },
      '../../../../../package.json': { version: 'tracerVersion' },
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

  describe('setUrl', () => {
    it('should set the URL used in the flush', () => {
      const url = new URL('http://example.com:1234')
      writer.setUrl(url)
      writer.append([span])
      encoder.count.returns(2)
      encoder.makePayload.returns([Buffer.alloc(0)])
      writer.flush()
      expect(request.getCall(0).args[1]).to.contain({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port
      })
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

    it('should call callback when empty', (done) => {
      writer.flush(done)
    })

    it('should flush its traces to the agent, and call callback', (done) => {
      const expectedData = Buffer.from('prefixed')

      encoder.count.returns(2)
      encoder.makePayload.returns([expectedData])
      writer.flush(() => {
        expect(request.getCall(0).args[0]).to.eql([expectedData])
        expect(request.getCall(0).args[1]).to.eql({
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: `/v${protocolVersion}/traces`,
          method: 'PUT',
          headers: {
            'Content-Type': 'application/msgpack',
            'Datadog-Meta-Lang': 'nodejs',
            'Datadog-Meta-Lang-Version': process.version,
            'Datadog-Meta-Lang-Interpreter': 'v8',
            'Datadog-Meta-Tracer-Version': 'tracerVersion',
            'X-Datadog-Trace-Count': '2'
          },
          lookup: undefined
        })
        done()
      })
    })

    it('should log request errors', done => {
      const error = new Error('boom')

      request.yields(error)

      encoder.count.returns(1)
      writer.flush()

      setTimeout(() => {
        expect(log.error).to.have.been.calledWith(error)
        done()
      })
    })

    it('should update sampling rates', (done) => {
      encoder.count.returns(1)
      writer.flush(() => {
        expect(prioritySampler.update).to.have.been.calledWith({
          'service:hello,env:test': 1
        })
        done()
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
          expect(request.getCall(0).args[1]).to.contain({
            socketPath: url.pathname
          })
        })
      })
    })
  })
}

describe('Writer', () => {
  describe('0.4', () => describeWriter(0.4))

  describe('0.5', () => describeWriter(0.5))
})
