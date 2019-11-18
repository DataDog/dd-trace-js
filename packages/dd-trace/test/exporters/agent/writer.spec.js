'use strict'

const URL = require('url-parse')

describe('Writer', () => {
  let Writer
  let writer
  let trace
  let span
  let platform
  let response
  let format
  let encode
  let url
  let prioritySampler
  let log
  let tracer
  let scope

  beforeEach(() => {
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
        _tags: {},
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
      request: sinon.stub().yields(null, response),
      msgpack: {
        prefix: sinon.stub().returns([])
      }
    }

    format = sinon.stub().withArgs(span).returns('formatted')
    encode = sinon.stub().withArgs(['formatted']).returns('encoded')

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
      '../../platform': platform,
      '../../log': log,
      '../../format': format,
      '../../encode': encode,
      '../../../lib/version': 'tracerVersion'
    })
    writer = new Writer(url, prioritySampler)
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

      expect(writer._queue).to.deep.include('encoded')
    })

    it('should flush when full', () => {
      writer.append([span])
      writer._size = 8 * 1024 * 1024
      writer.append([span])

      expect(writer.length).to.equal(1)
      expect(writer._queue).to.deep.include('encoded')
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
      platform.msgpack.prefix.withArgs(['encoded', 'encoded']).returns(['prefixed'])
      platform.name.returns('lang')
      platform.version.returns('version')
      platform.engine.returns('interpreter')

      writer.append([span])
      writer.append([span])
      writer.flush()

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
        data: ['prefixed']
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
        writer = new Writer(url, 3)
      })

      it('should make a request to the socket', () => {
        writer.append([span])
        writer.flush()

        expect(platform.request).to.have.been.calledWithMatch({
          socketPath: url.pathname
        })
      })
    })
  })
})
