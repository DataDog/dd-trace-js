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
      request: sinon.stub().yields(null, response, version === 0.5 ? 200 : 404),
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
    writer = new Writer(url, prioritySampler)

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
      // once for the protocol version check
      expect(platform.request).to.have.been.calledOnce
      writer.flush()

      // no more times
      expect(platform.request).to.have.been.calledOnce
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

  describe('endpoint version fallback', () => {
    let Writer
    let platform
    let encode05
    let encode04
    beforeEach(() => {
      platform = {
        name: sinon.stub(),
        version: sinon.stub(),
        engine: sinon.stub(),
        msgpack: {
          prefix: sinon.stub().returns([Buffer.alloc(0)])
        }
      }

      encode04 = {
        encode: sinon.stub().returns(40),
        makePayload: x => x,
        init: () => {}
      }
      encode05 = {
        encode: sinon.stub().returns(50),
        makePayload: x => x,
        init: () => {}
      }

      Writer = proxyquire('../src/exporters/agent/writer', {
        '../../platform': platform,
        '../../encode/0.4': encode04,
        '../../encode/0.5': encode05,
        '../../../lib/version': 'tracerVersion'
      })
    })

    it('drops traces when there is an error before protocol version is set, then retries', (done) => {
      let writer

      const url = {
        protocol: 'https',
        hostname: 'example.com',
        port: 12345
      }
      const prioritySampler = {}
      const lookup = {}

      platform.request = (payload, cb) => {
        expect(writer._appends).to.deep.equal(['spans1', 'spans2'])
        expect(writer._needsFlush).to.equal(true)
        platform.request = (payload, cb) => {
          cb(null, null, 200) // avoid calling again
          done()
        }
        cb()
        expect(writer._appends.length).to.equal(0)
        expect(writer._needsFlush).to.equal(false)
      }

      writer = new Writer(url, prioritySampler, lookup)
      writer.append('spans1')
      writer.append('spans2')
      writer.flush()
    })

    ;[
      ['works when 0.5 is available', null, () => encode05],
      ['works when 0.5 is not available', new Error(), () => encode04]
    ].forEach(([testCase, error, encoder]) => {
      it(testCase, (done) => {
        encoder = encoder()
        const is05 = encoder === encode05
        const encode = encoder.encode

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
            platform.request = (payload, cb) => {
              expect(payload).to.deep.equal({
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port,
                data: [ Buffer.from([]) ],
                path: `/v0.${is05 ? 5 : 4}/traces`,
                method: 'PUT',
                headers: {
                  'Content-Type': 'application/msgpack',
                  'Datadog-Meta-Tracer-Version': 'tracerVersion',
                  'X-Datadog-Trace-Count': '2'
                },
                lookup: lookup
              })

              cb(null, {})

              done()
            }
            cb(null, {}, is05 ? 200 : 404)

            expect(encode).to.have.been.calledTwice
            expect(encode.firstCall.args[1]).to.equal(5)
            expect(encode.firstCall.args[2]).to.equal('spans1')
            expect(encode.firstCall.args[3]).to.equal(writer)
            expect(encode.secondCall.args[1]).to.equal(encoder === encode05 ? 50 : 40)
            expect(encode.secondCall.args[2]).to.equal('spans2')
            expect(encode.secondCall.args[3]).to.equal(writer)
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
