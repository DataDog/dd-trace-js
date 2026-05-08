'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('tracer_metadata', () => {
  let storeConfig
  let storeMetadataStub
  let TracerMetadataStub
  let processDiscoveryStub
  let libdatadogStub
  let dockerStub
  let processTagsStub

  const baseConfig = {
    tags: { 'runtime-id': 'test-runtime-id' },
    hostname: 'test-host',
    service: 'test-service',
    env: 'test-env',
    version: '1.0.0',
    DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED: false,
  }

  beforeEach(() => {
    storeMetadataStub = sinon.stub().returns({ handle: 'mock-handle' })
    TracerMetadataStub = sinon.stub()

    processDiscoveryStub = {
      TracerMetadata: TracerMetadataStub,
      storeMetadata: storeMetadataStub,
    }

    libdatadogStub = {
      maybeLoad: sinon.stub().withArgs('process-discovery').returns(processDiscoveryStub),
    }

    dockerStub = { containerId: undefined }
    processTagsStub = { serialized: 'tag1:val1,tag2:val2' }

    storeConfig = proxyquire('../src/tracer_metadata', {
      '@datadog/libdatadog': libdatadogStub,
      './exporters/common/docker': dockerStub,
      './process-tags': processTagsStub,
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  it('calls storeMetadata with correct base fields', () => {
    storeConfig(baseConfig)

    sinon.assert.calledOnce(TracerMetadataStub)
    const args = TracerMetadataStub.firstCall.args
    assert.strictEqual(args[0], 'test-runtime-id')
    assert.strictEqual(args[2], 'test-host')
    assert.strictEqual(args[3], 'test-service')
    assert.strictEqual(args[4], 'test-env')
    assert.strictEqual(args[5], '1.0.0')

    sinon.assert.calledOnce(storeMetadataStub)
  })

  it('passes null for process_tags when propagateProcessTags is disabled', () => {
    storeConfig({ ...baseConfig, DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED: false })

    const args = TracerMetadataStub.firstCall.args
    assert.strictEqual(args[6], null)
  })

  it('passes serialized process tags when propagateProcessTags is enabled', () => {
    storeConfig({ ...baseConfig, DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED: true })

    const args = TracerMetadataStub.firstCall.args
    assert.strictEqual(args[6], 'tag1:val1,tag2:val2')
  })

  it('passes container_id when available', () => {
    dockerStub.containerId = 'abc123container'

    storeConfig(baseConfig)

    const args = TracerMetadataStub.firstCall.args
    assert.strictEqual(args[7], 'abc123container')
  })

  it('passes null for container_id when not in a container', () => {
    dockerStub.containerId = undefined

    storeConfig(baseConfig)

    const args = TracerMetadataStub.firstCall.args
    assert.strictEqual(args[7], null)
  })

  it('passes null for service when config.service is falsy', () => {
    storeConfig({ ...baseConfig, service: undefined })

    const args = TracerMetadataStub.firstCall.args
    assert.strictEqual(args[3], null)
  })

  it('returns undefined and does not throw when process-discovery is unavailable', () => {
    libdatadogStub.maybeLoad.returns(undefined)

    const result = storeConfig(baseConfig)
    assert.strictEqual(result, undefined)
  })

  it('returns undefined and does not throw when libdatadog throws', () => {
    const storeConfigWithThrow = proxyquire('../src/tracer_metadata', {
      '@datadog/libdatadog': { maybeLoad: () => { throw new Error('load error') } },
      './exporters/common/docker': dockerStub,
      './process-tags': processTagsStub,
    })

    const result = storeConfigWithThrow(baseConfig)
    assert.strictEqual(result, undefined)
  })
})
