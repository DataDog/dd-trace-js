'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')
const msgpack = require('@msgpack/msgpack')
const proxyquire = require('proxyquire')

require('../setup/core')
const pkg = require('../../../../package.json')
const { MAX_SIZE, OverflowError } = require('../../src/msgpack')

const stubRequest = sinon.stub()

const stubZlib = {
  gzip: (payload, _opts, fn) => {
    fn(undefined, payload)
  },
}

const { DataStreamsWriter } = proxyquire(
  '../../src/datastreams/writer', {
    '../exporters/common/request': stubRequest,
    zlib: stubZlib,
  })

describe('DataStreamWriter unix', () => {
  let writer
  const unixConfig = {
    hostname: '',
    url: new URL('unix:///var/run/datadog/apm.socket'),
    port: '',
  }

  it('should construct unix config', () => {
    writer = new DataStreamsWriter(unixConfig)
    assert.strictEqual(writer._url, unixConfig.url)
  })

  it("should call 'request' through flush with correct options", () => {
    writer = new DataStreamsWriter(unixConfig)
    writer.flush({})
    const stubRequestCall = stubRequest.getCalls()[0]
    const decodedPayload = msgpack.decode(stubRequestCall?.args[0])
    const requestOptions = stubRequestCall?.args[1]
    assert.deepStrictEqual(decodedPayload, {})
    assert.deepStrictEqual(requestOptions, {
      path: '/v0.1/pipeline_stats',
      method: 'POST',
      headers: {
        'Datadog-Meta-Lang': 'javascript',
        'Datadog-Meta-Tracer-Version': pkg.version,
        'Content-Type': 'application/msgpack',
        'Content-Encoding': 'gzip',
      },
      url: unixConfig.url,
    })
  })

  it('drops the payload and logs when msgpack encoding hits the chunk cap', () => {
    const localStubRequest = sinon.stub()
    const errorLog = sinon.stub()
    const overflow = new OverflowError(MAX_SIZE + 1)

    const { DataStreamsWriter: GuardedWriter } = proxyquire(
      '../../src/datastreams/writer', {
        '../exporters/common/request': localStubRequest,
        '../msgpack': {
          encode () { throw overflow },
          MAX_SIZE,
        },
        '../log': { error: errorLog, debug: sinon.stub() },
        zlib: stubZlib,
      })

    const guarded = new GuardedWriter(unixConfig)
    guarded.flush({ pathological: true })

    sinon.assert.notCalled(localStubRequest)
    sinon.assert.calledOnce(errorLog)
  })

  it('rethrows non-overflow encoding errors', () => {
    const { DataStreamsWriter: ThrowingWriter } = proxyquire(
      '../../src/datastreams/writer', {
        '../exporters/common/request': sinon.stub(),
        '../msgpack': {
          encode () { throw new Error('not an overflow') },
          MAX_SIZE: 50 * 1024 * 1024,
        },
        zlib: stubZlib,
      })

    const throwing = new ThrowingWriter(unixConfig)
    assert.throws(() => throwing.flush({}), /not an overflow/)
  })
})
