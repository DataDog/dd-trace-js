'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const { makeSpan } = require('../../encode/streaming-fixtures')

require('../../setup/core')

describe('common Writer', () => {
  let Writer
  let writer
  let encoder
  let log

  function buildWriter (writable) {
    log = { debug: sinon.stub() }
    Writer = proxyquire('../../../src/exporters/common/writer', {
      './request': { writable, '@noCallThru': true },
      '../../log': log,
    })
    writer = new Writer({ url: 'http://localhost:8126' })
    encoder = { encode: sinon.stub(), encodeRaw: sinon.stub() }
    writer._encoder = encoder
  }

  describe('when the request buffer is full', () => {
    beforeEach(() => buildWriter(false))

    it('drops appended payloads instead of encoding', () => {
      writer.append([{}])

      sinon.assert.notCalled(encoder.encode)
    })

    it('drops raw appended spans instead of encoding', () => {
      writer.appendRaw([{}], false)

      sinon.assert.notCalled(encoder.encodeRaw)
    })
  })

  describe('when the request buffer has room', () => {
    beforeEach(() => buildWriter(true))

    it('encodes raw appended spans with the process tags', () => {
      writer.appendRaw([{}], 'service:web')

      sinon.assert.calledWith(encoder.encodeRaw, [{}], 'service:web')
      sinon.assert.notCalled(encoder.encode)
    })

    it('logs the formatted payload so DD_TRACE_DEBUG surfaces first-span chunk tags', () => {
      const firstSpan = makeSpan({ traceTags: { '_dd.git.repository_url': 'https://github.com/DataDog/dd-trace-js' } })
      const secondSpan = makeSpan()

      writer.appendRaw([firstSpan, secondSpan], false)

      sinon.assert.called(log.debug)
      const message = log.debug.getCall(0).args[0]()
      // The chunk tag is emitted on the first span only, never repeated on the rest.
      assert.match(message, /"_dd\.git\.repository_url":"https:\/\/github\.com\/DataDog\/dd-trace-js"/)
      assert.strictEqual(message.match(/_dd\.git\.repository_url/g).length, 1)
    })
  })
})
