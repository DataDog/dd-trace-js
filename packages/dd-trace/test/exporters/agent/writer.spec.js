'use strict'

const URL = require('url-parse')

const id = require('../../../src/id')

function describeWriter (protocolVersion) {
  let Writer
  let writer
  let trace
  let span
  let platform
  let response
  let format
  let encodedLength
  let encode
  let url
  let prioritySampler
  let log
  let tracer
  let scope

  beforeEach((done) => {
    scope = {
      _wipe: sinon.stub()
    }

    tracer = {
      scope: sinon.stub().returns(scope)
    }

    trace = {
      started: [],
      finished: []
    }

    span = {
      tracer: sinon.stub().returns(tracer),
      context: sinon.stub().returns({
        _trace: trace,
        _sampling: {},
        _tags: {
          trace_id: id('1'),
          span_id: id('2'),
          parent_id: id('0'),
          start: 3,
          duration: 4
        },
        _traceFlags: {}
      })
    }

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

    format = sinon.stub().withArgs(span).returns('formatted')

    encodedLength = 12
    encode = {
      encode: function (buf) {
        buf[0] = 101
        return encodedLength
      },
      makePayload: x => x,
      init: () => {}
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

    Writer = proxyquire('../src/exporters/agent/writer', {
      '../../format': format,
      '../../encode/0.4': encode,
      '../../encode/0.5': encode,
      '../../platform': platform,
      '../../../lib/version': 'tracerVersion',
      '../../log': log
    })
    writer = new Writer({ url, prioritySampler, protocolVersion })

    process.nextTick(done)
  })

  describe('length', () => {
    it('should return the number of traces', () => {
      writer.append([span])
      writer.append([span])

      expect(writer.length).to.equal(2)
    })
  })

  describe('append', () => {
    it('should append a trace', () => {
      writer.append([span])

      const expectedTraceLen = 12
      expect(writer._offset).to.equal(expectedTraceLen)
    })
  })

  describe('flush', () => {
    it('should skip flushing if empty', () => {
      writer.flush()

      expect(platform.request).to.not.have.been.called
    })

    it('should empty the internal queue', () => {
      writer.append([span])
      writer.flush()

      expect(writer.length).to.equal(0)
    })

    it('should flush its traces to the agent', () => {
      platform.msgpack.prefix.returns([Buffer.from('prefixed')])
      platform.name.returns('lang')
      platform.version.returns('version')
      platform.engine.returns('interpreter')

      writer.append([span])
      writer.append([span])
      writer.flush()
      const expectedData = Buffer.from('prefixed')

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

      writer.append([span])
      writer.flush()

      setTimeout(() => {
        expect(log.error).to.have.been.calledWith(error)
        done()
      })
    })

    it('should update sampling rates', () => {
      writer.append([span])
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
        writer.append([span])
        writer.flush()
        setImmediate(() => {
          expect(platform.request).to.have.been.calledWithMatch({
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
