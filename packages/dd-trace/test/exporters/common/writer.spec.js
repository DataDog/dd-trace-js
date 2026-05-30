'use strict'

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../setup/core')

describe('common Writer', () => {
  let Writer
  let writer
  let encoder

  function buildWriter (writable) {
    Writer = proxyquire('../../../src/exporters/common/writer', {
      './request': { writable, '@noCallThru': true },
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
  })
})
