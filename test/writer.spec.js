'use strict'

const URL = require('url-parse')

describe('Writer', () => {
  let Writer
  let writer
  let prioritySampler
  let trace
  let span
  let platform
  let request
  let response
  let format
  let encode
  let url
  let log

  beforeEach(() => {
    trace = {
      started: [span],
      finished: [span]
    }

    span = {
      context: sinon.stub().returns({
        _trace: trace,
        _sampling: {}
      })
    }

    response = JSON.stringify({
      rate_by_service: {
        'service:hello,env:test': 1
      }
    })

    request = Promise.resolve(response)

    platform = {
      name: sinon.stub(),
      version: sinon.stub(),
      engine: sinon.stub(),
      request: sinon.stub().returns(request),
      msgpack: {
        prefix: sinon.stub()
      }
    }

    format = sinon.stub().withArgs(span).returns('formatted')
    encode = sinon.stub().withArgs(['formatted']).returns('encoded')

    url = {
      protocol: 'http:',
      hostname: 'localhost',
      port: 8126
    }

    log = {
      error: sinon.spy()
    }

    prioritySampler = {
      update: sinon.stub()
    }

    Writer = proxyquire('../src/writer', {
      './platform': platform,
      './log': log,
      './format': format,
      './encode': encode,
      '../lib/version': 'tracerVersion'
    })
    writer = new Writer(prioritySampler, url, 3)
  })

  describe('length', () => {
    it('should return the number of traces', () => {
      writer.append(span)
      writer.append(span)

      expect(writer.length).to.equal(2)
    })
  })

  describe('append', () => {
    it('should append a trace', () => {
      writer.append(span)

      expect(writer._queue).to.deep.include('encoded')
    })

    it('should skip traces with unfinished spans', () => {
      trace.finished = []
      writer.append(span)

      expect(writer._queue).to.be.empty
    })

    it('should replace a random trace when full', () => {
      writer._queue = new Array(1000)
      writer.append(span)

      expect(writer.length).to.equal(1000)
      expect(writer._queue).to.deep.include('encoded')
    })
  })

  describe('drop', () => {
    beforeEach(() => {
      span.context = sinon.stub().returns({
        _trace: trace,
        _sampling: {
          drop: true
        }
      })
    })

    it('should not append if being dropped', () => {
      writer.append(span)

      expect(writer._queue).to.be.empty
    })
  })

  describe('flush', () => {
    it('should skip flushing if empty', () => {
      writer.flush()

      expect(platform.request).to.not.have.been.called
    })

    it('should empty the internal queue', () => {
      writer.append(span)
      writer.flush()

      expect(writer.length).to.equal(0)
    })

    it('should flush its traces to the agent', () => {
      platform.msgpack.prefix.withArgs(['encoded', 'encoded']).returns('prefixed')
      platform.name.returns('lang')
      platform.version.returns('version')
      platform.engine.returns('interpreter')

      writer.append(span)
      writer.append(span)
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
        data: 'prefixed'
      })
    })

    it('should log request errors', done => {
      const error = new Error('boom')

      platform.request.returns(Promise.reject(error))

      writer.append(span)
      writer.flush()

      setTimeout(() => {
        expect(log.error).to.have.been.calledWith(error)
        done()
      })
    })

    context('with the url as a unix socket', () => {
      beforeEach(() => {
        url = new URL('unix:/path/to/somesocket.sock')
        writer = new Writer(prioritySampler, url, 3)
      })

      it('should make a request to the socket', () => {
        writer.append(span)
        writer.flush()

        expect(platform.request).to.have.been.calledWithMatch({
          socketPath: url.pathname
        })
      })
    })
  })
})
