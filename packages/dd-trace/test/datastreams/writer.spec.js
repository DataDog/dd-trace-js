'use strict'
const t = require('tap')
require('../setup/core')
const pkg = require('../../../../package.json')
const stubRequest = sinon.stub()
const msgpack = require('@msgpack/msgpack')

const stubZlib = {
  gzip: (payload, _opts, fn) => {
    fn(undefined, payload)
  }
}

const { DataStreamsWriter } = proxyquire(
  '../src/datastreams/writer', {
    '../exporters/common/request': stubRequest,
    zlib: stubZlib
  })

t.test('DataStreamWriter unix', t => {
  let writer
  const unixConfig = {
    hostname: '',
    url: new URL('unix:///var/run/datadog/apm.socket'),
    port: ''
  }

  t.test('should construct unix config', t => {
    writer = new DataStreamsWriter(unixConfig)
    expect(writer._url).to.equal(unixConfig.url)
    t.end()
  })

  t.test("should call 'request' through flush with correct options", t => {
    writer = new DataStreamsWriter(unixConfig)
    writer.flush({})
    const stubRequestCall = stubRequest.getCalls()[0]
    const decodedPayload = msgpack.decode(stubRequestCall?.args[0])
    const requestOptions = stubRequestCall?.args[1]
    expect(decodedPayload).to.deep.equal({})
    expect(requestOptions).to.deep.equal({
      path: '/v0.1/pipeline_stats',
      method: 'POST',
      headers: {
        'Datadog-Meta-Lang': 'javascript',
        'Datadog-Meta-Tracer-Version': pkg.version,
        'Content-Type': 'application/msgpack',
        'Content-Encoding': 'gzip'
      },
      url: unixConfig.url
    })
    t.end()
  })
  t.end()
})
