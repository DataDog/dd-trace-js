'use strict'
const pkg = require('../../../../package.json')
const stubRequest = sinon.stub()

const { DataStreamsWriter } = proxyquire(
  '../src/datastreams/writer', {
    '../exporters/common/request': stubRequest
  })

require('../setup/tap')

describe('DataStreamWriter unix', () => {
  let writer
  const unixConfig = {
    hostname: '',
    url: new URL('unix:///var/run/datadog/apm.socket'),
    port: ''
  }

  it('should construct unix config', () => {
    writer = new DataStreamsWriter(unixConfig)
    expect(writer._url).to.equal(unixConfig.url)
  })

  it("should call 'request' through flush with correct options", () => {
    writer = new DataStreamsWriter(unixConfig)
    writer.flush({})
    expect(stubRequest).to.be.calledWith(
      {},
      {
        path: '/v0.1/pipeline_stats',
        method: 'POST',
        headers: {
          'Datadog-Meta-Lang': 'javascript',
          'Datadog-Meta-Tracer-Version': pkg.version,
          'Content-Type': 'application/msgpack',
          'Content-Encoding': 'gzip'
        },
        url: unixConfig.url
      }
    )
  })
})
