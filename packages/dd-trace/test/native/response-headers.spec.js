'use strict'

const assert = require('node:assert/strict')

const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()

require('../setup/core')

describe('native response header observer', () => {
  let responseHeaderObserver
  let updateContainerTagsHash

  beforeEach(() => {
    updateContainerTagsHash = sinon.stub()
    const pipeline = {
      WasmSpanState: class WasmSpanState {},
      init: sinon.stub(),
      setResponseHeaderObserver: sinon.stub().callsFake((observer) => {
        responseHeaderObserver = observer
      }),
      setStorage: sinon.stub(),
    }
    const native = proxyquire('../../src/native', {
      '@datadog/libdatadog': {
        load: sinon.stub().returns(pipeline),
        pipelineApiVersion: 1,
      },
      '../propagation-hash': { updateContainerTagsHash },
    })

    assert.strictEqual(native.pipelineApiVersion, 1)
    assert.ok(native.WasmSpanState)
    sinon.assert.calledOnceWithExactly(pipeline.setResponseHeaderObserver, responseHeaderObserver)
  })

  it('feeds Datadog-Container-Tags-Hash to the propagation hash', () => {
    // Without this the native path hashes process tags alone, so DBM SQL comments
    // and DSM pathway hashes cannot correlate with container tags.
    responseHeaderObserver(['Content-Type', 'application/json', 'Datadog-Container-Tags-Hash', 'abc123'])

    sinon.assert.calledOnceWithExactly(updateContainerTagsHash, 'abc123')
  })

  it('reports an older binding without a pipeline API marker', () => {
    const native = proxyquire('../../src/native', {
      '@datadog/libdatadog': {},
    })

    assert.strictEqual(native.pipelineApiVersion, 0)
  })

  it('caches the pipeline only after setup completes', () => {
    const expected = new Error('storage setup failed')
    const pipeline = {
      WasmSpanState: class WasmSpanState {},
      init: sinon.stub(),
      setResponseHeaderObserver: sinon.stub(),
      setStorage: sinon.stub(),
    }
    pipeline.setStorage.onFirstCall().throws(expected)
    const load = sinon.stub().returns(pipeline)
    const native = proxyquire('../../src/native', {
      '@datadog/libdatadog': { load },
      '../propagation-hash': { updateContainerTagsHash },
    })

    assert.throws(() => native.WasmSpanState, expected)
    assert.strictEqual(native.WasmSpanState, pipeline.WasmSpanState)
    sinon.assert.calledTwice(load)
    sinon.assert.calledTwice(pipeline.init)
    sinon.assert.calledTwice(pipeline.setStorage)
    sinon.assert.calledOnce(pipeline.setResponseHeaderObserver)
  })

  it('rejects a pipeline without native span state', () => {
    const pipeline = {
      init: sinon.stub(),
      setResponseHeaderObserver: sinon.stub(),
      setStorage: sinon.stub(),
    }
    const native = proxyquire('../../src/native', {
      '@datadog/libdatadog': { load: sinon.stub().returns(pipeline) },
      '../propagation-hash': { updateContainerTagsHash },
    })

    assert.throws(
      () => native.WasmSpanState,
      /@datadog\/libdatadog pipeline crate is missing WasmSpanState/,
    )
    sinon.assert.notCalled(pipeline.init)
  })

  it('rejects recursive native interface loading', () => {
    const legacy = {
      enterWith: sinon.stub(),
      getStore: sinon.stub(),
      run: sinon.stub(),
    }
    legacy.enterWith.onFirstCall().callsFake(() => native.NativeSpansInterface)
    const native = proxyquire('../../src/native', {
      '../../../datadog-core': { storage: sinon.stub().returns(legacy) },
      '@datadog/libdatadog': { load: sinon.stub() },
      '../propagation-hash': { updateContainerTagsHash },
    })

    assert.throws(() => native.NativeSpansInterface, /Recursive native module load detected/)
    sinon.assert.calledTwice(legacy.enterWith)
  })

  it('matches the header case-insensitively', () => {
    // rawHeaders preserves whatever casing the agent sent.
    responseHeaderObserver(['datadog-container-tags-hash', 'lower'])

    sinon.assert.calledOnceWithExactly(updateContainerTagsHash, 'lower')
  })

  it('takes the first value when the agent repeats the header', () => {
    responseHeaderObserver([
      'Datadog-Container-Tags-Hash', 'first',
      'Datadog-Container-Tags-Hash', 'second',
    ])

    sinon.assert.calledOnceWithExactly(updateContainerTagsHash, 'first')
  })

  it('ignores a response without the header', () => {
    responseHeaderObserver(['Content-Type', 'application/json'])

    sinon.assert.notCalled(updateContainerTagsHash)
  })

  it('ignores an empty hash value', () => {
    responseHeaderObserver(['Datadog-Container-Tags-Hash', ''])

    sinon.assert.notCalled(updateContainerTagsHash)
  })

  it('tolerates a non-array or odd-length payload', () => {
    // The transport catches observer throws, but a throw would still mean the
    // hash silently stops updating, so handle the shapes here. A throw from any
    // of these fails the test directly.
    for (const payload of [undefined, null, {}, 'nope', ['Datadog-Container-Tags-Hash']]) {
      responseHeaderObserver(payload)
    }

    sinon.assert.notCalled(updateContainerTagsHash)
  })
})
