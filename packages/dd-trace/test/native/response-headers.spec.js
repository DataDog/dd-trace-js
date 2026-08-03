'use strict'

const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

describe('native response header observer', () => {
  let observeResponseHeaders
  let updateContainerTagsHash

  beforeEach(() => {
    updateContainerTagsHash = sinon.stub()
    ;({ observeResponseHeaders } = proxyquire('../../src/native', {
      '../propagation-hash': { updateContainerTagsHash },
    }))
  })

  it('feeds Datadog-Container-Tags-Hash to the propagation hash', () => {
    // Without this the native path hashes process tags alone, so DBM SQL comments
    // and DSM pathway hashes cannot correlate with container tags.
    observeResponseHeaders(['Content-Type', 'application/json', 'Datadog-Container-Tags-Hash', 'abc123'])

    sinon.assert.calledOnceWithExactly(updateContainerTagsHash, 'abc123')
  })

  it('matches the header case-insensitively', () => {
    // rawHeaders preserves whatever casing the agent sent.
    observeResponseHeaders(['datadog-container-tags-hash', 'lower'])

    sinon.assert.calledOnceWithExactly(updateContainerTagsHash, 'lower')
  })

  it('takes the first value when the agent repeats the header', () => {
    observeResponseHeaders([
      'Datadog-Container-Tags-Hash', 'first',
      'Datadog-Container-Tags-Hash', 'second',
    ])

    sinon.assert.calledOnceWithExactly(updateContainerTagsHash, 'first')
  })

  it('ignores a response without the header', () => {
    observeResponseHeaders(['Content-Type', 'application/json'])

    sinon.assert.notCalled(updateContainerTagsHash)
  })

  it('ignores an empty hash value', () => {
    observeResponseHeaders(['Datadog-Container-Tags-Hash', ''])

    sinon.assert.notCalled(updateContainerTagsHash)
  })

  it('tolerates a non-array or odd-length payload', () => {
    // The transport catches observer throws, but a throw would still mean the
    // hash silently stops updating, so handle the shapes here. A throw from any
    // of these fails the test directly.
    for (const payload of [undefined, null, {}, 'nope', ['Datadog-Container-Tags-Hash']]) {
      observeResponseHeaders(payload)
    }

    sinon.assert.notCalled(updateContainerTagsHash)
  })
})
