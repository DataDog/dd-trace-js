'use strict'

const URL = require('url-parse')

const id = require('../../../src/id')

function describeWriter (version) {
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
      request: sinon.stub().yields(null, response),
      msgpack: {
        prefix: sinon.stub().returns([Buffer.alloc(0)])
      }
    }

    format = sinon.stub().withArgs(span).returns('formatted')

    encodedLength = 12
    encode = function (buf) {
      buf[0] = 101
      return encodedLength
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

    Writer = proxyquire('../src/exporters/agent/writer-' + version, {
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

      const expectedTraceLen = version === 0.5 ? 79 : 12
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
      const expectedData = version === 0.5 ? Buffer.concat([
        Buffer.from([0x92, 0xdc, 0x00, 0x01, 0xa0]),
        Buffer.from('prefixed')
      ]) : Buffer.from('prefixed')

      expect(platform.request).to.have.been.calledWithMatch({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `/v${version}/traces`,
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
}

describe('Writer', () => {
  describe('0.4', () => describeWriter(0.4))

  describe('0.5', () => describeWriter(0.5))

  describe('endpoint version fallback', () => {
    let Writer
    let Writer04
    let Writer05
    let platform
    beforeEach(() => {
      platform = {
        name: sinon.stub(),
        version: sinon.stub(),
        engine: sinon.stub(),
        msgpack: {
          prefix: sinon.stub().returns([Buffer.alloc(0)])
        }
      }
      class BaseWriter {
        constructor (url, prioritySampler, lookup) {
          this._url = url
          this._prioritySampler = prioritySampler
          this._lookup = lookup
        }
      }
      Writer04 = class Writer04 extends BaseWriter {}
      Writer04.prototype.append = sinon.stub()
      Writer04.prototype.flush = sinon.stub()
      Writer05 = class Writer05 extends BaseWriter {}
      Writer05.prototype.append = sinon.stub()
      Writer05.prototype.flush = sinon.stub()
      Writer = proxyquire('../src/exporters/agent/writer', {
        '../../platform': platform,
        '../../../lib/version': 'tracerVersion',
        './writer-0.4': Writer04,
        './writer-0.5': Writer05
      })
    })

    ;[
      ['works when 0.5 is available', null, () => Writer05],
      ['works when 0.5 is not available', new Error(), () => Writer04]
    ].forEach(([testCase, error, writerClass]) => {
      it(testCase, (done) => {
        const url = {
          protocol: 'https',
          hostname: 'example.com',
          port: 12345
        }
        const prioritySampler = {}
        const lookup = {}

        let writer // eslint-disable-line prefer-const

        platform.request = (payload, cb) => {
          process.nextTick(() => {
            expect(payload).to.deep.equal({
              protocol: url.protocol,
              hostname: url.hostname,
              port: url.port,
              data: [ Buffer.from([0x92, 0x90, 0x90]) ],
              path: '/v0.5/traces',
              method: 'PUT',
              headers: {
                'Content-Type': 'application/msgpack',
                'Datadog-Meta-Tracer-Version': 'tracerVersion',
                'X-Datadog-Trace-Count': '0'
              },
              lookup: lookup
            })
            cb(error)
            expect(writer._writer).to.be.instanceof(writerClass())
            expect(writer._writer.append).to.have.been.calledTwice
            expect(writer._writer.append).to.have.been.calledWith('spans1')
            expect(writer._writer.append).to.have.been.calledWith('spans2')
            expect(writer._writer.flush).to.have.been.calledOnce
            writer._writer.append = sinon.stub()
            writer._writer.flush = sinon.stub()
            writer.append('spans3')
            writer.flush()
            expect(writer._writer.append).to.have.been.calledOnce
            expect(writer._writer.append).to.have.been.calledWith('spans3')
            expect(writer._writer.flush).to.have.been.calledOnce
            done()
          })
        }

        writer = new Writer(url, prioritySampler, lookup)
        writer.append('spans1')
        writer.append('spans2')
        writer.flush()
      })
    })
  })
})
