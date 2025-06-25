'use strict'

const t = require('tap')
require('../../setup/core')

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

  t.beforeEach(async () => {
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

    url = new URL('http://localhost:8126')

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

    return new Promise(resolve => {
      process.nextTick(resolve)
    })
  })

  t.test('append', t => {
    t.test('should append a trace', t => {
      writer.append([span])

      expect(encoder.encode).to.have.been.calledWith([span])
      t.end()
    })
    t.end()
  })

  t.test('setUrl', t => {
    t.test('should set the URL used in the flush', t => {
      const url = new URL('http://example.com:1234')
      writer.setUrl(url)
      writer.append([span])
      encoder.count.returns(2)
      encoder.makePayload.returns([Buffer.alloc(0)])
      writer.flush()
      expect(request.getCall(0).args[1]).to.contain({
        url
      })
      t.end()
    })
    t.end()
  })

  t.test('flush', t => {
    t.test('should skip flushing if empty', t => {
      writer.flush()

      expect(encoder.makePayload).to.not.have.been.called
      t.end()
    })

    t.test('should empty the internal queue', t => {
      encoder.count.returns(1)

      writer.flush()

      expect(encoder.makePayload).to.have.been.called
      t.end()
    })

    t.test('should call callback when empty', (t) => {
      writer.flush(t.end)
    })

    t.test('should flush its traces to the agent, and call callback', (t) => {
      const expectedData = Buffer.from('prefixed')

      encoder.count.returns(2)
      encoder.makePayload.returns([expectedData])
      writer.flush(() => {
        expect(request.getCall(0).args[0]).to.eql([expectedData])
        expect(request.getCall(0).args[1]).to.eql({
          url,
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
        t.end()
      })
    })

    t.test('should pass through headers', (t) => {
      const headers = {
        'My-Header': 'bar'
      }
      writer = new Writer({ url, prioritySampler, protocolVersion, headers })
      encoder.count.returns(2)
      encoder.makePayload.returns([Buffer.from('data')])
      writer.flush(() => {
        expect(request.getCall(0).args[1].headers).to.eql({
          ...headers,
          'Content-Type': 'application/msgpack',
          'Datadog-Meta-Lang': 'nodejs',
          'Datadog-Meta-Lang-Version': process.version,
          'Datadog-Meta-Lang-Interpreter': 'v8',
          'Datadog-Meta-Tracer-Version': 'tracerVersion',
          'X-Datadog-Trace-Count': '2'
        })
        t.end()
      })
    })

    t.test('should log request errors', t => {
      const error = new Error('boom')
      error.status = 42

      request.yields(error)

      encoder.count.returns(1)
      writer.flush()

      setTimeout(() => {
        expect(log.error)
          .to.have.been.calledWith('Error sending payload to the agent (status code: %s)', error.status, error)
        t.end()
      })
    })

    t.test('should update sampling rates', (t) => {
      encoder.count.returns(1)
      writer.flush(() => {
        expect(prioritySampler.update).to.have.been.calledWith({
          'service:hello,env:test': 1
        })
        t.end()
      })
    })

    context('with the url as a unix socket', () => {
      t.beforeEach(() => {
        url = new URL('unix:/path/to/somesocket.sock')
        writer = new Writer({ url, protocolVersion })
      })

      t.test('should make a request to the socket', t => {
        encoder.count.returns(1)
        writer.flush()
        setImmediate(() => {
          expect(request.getCall(0).args[1]).to.contain({
            url
          })
        })
        t.end()
      })
    })
    t.end()
  })
}

t.test('Writer', t => {
  t.test('0.4', t => describeWriter(0.4))

  t.test('0.5', t => describeWriter(0.5))
  t.end()
})
