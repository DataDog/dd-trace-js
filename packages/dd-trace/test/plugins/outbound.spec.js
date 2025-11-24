'use strict'

const assert = require('node:assert/strict')

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach, before } = require('tap').mocha
const sinon = require('sinon')

require('../setup/core')

const { getNextLineNumber } = require('./helpers')
const OutboundPlugin = require('../../src/plugins/outbound')
const parseTags = require('../../../datadog-core/src/utils/src/parse-tags')

describe('OuboundPlugin', () => {
  describe('peer service decision', () => {
    let instance = null
    let computePeerServiceStub = null
    let getPeerServiceStub = null
    let getRemapStub = null

    beforeEach(() => {
      instance = new OutboundPlugin()
      computePeerServiceStub = sinon.stub(instance, '_tracerConfig')
      getPeerServiceStub = sinon.stub(instance, 'getPeerService')
      getRemapStub = sinon.stub(instance, 'getPeerServiceRemap')
    })

    afterEach(() => {
      computePeerServiceStub.restore()
      getPeerServiceStub.restore()
      getRemapStub.restore()
    })

    it('should attempt to remap when we found peer service', () => {
      computePeerServiceStub.value({ spanComputePeerService: true })
      getPeerServiceStub.returns({ foo: 'bar' })
      instance.tagPeerService({ context: () => { return { _tags: {} } }, addTags: () => {} })

      sinon.assert.called(getPeerServiceStub)
      sinon.assert.called(getRemapStub)
    })

    it('should not attempt to remap if we found no peer service', () => {
      computePeerServiceStub.value({ spanComputePeerService: true })
      getPeerServiceStub.returns(undefined)
      instance.tagPeerService({ context: () => { return { _tags: {} } }, addTags: () => {} })

      sinon.assert.called(getPeerServiceStub)
      expect(getRemapStub).to.not.be.called
    })

    it('should do nothing when disabled', () => {
      computePeerServiceStub.value({ spanComputePeerService: false })
      instance.tagPeerService({ context: () => { return { _tags: {} } }, addTags: () => {} })
      expect(getPeerServiceStub).to.not.be.called
      expect(getRemapStub).to.not.be.called
    })
  })

  describe('peer.service computation', () => {
    let instance = null

    before(() => {
      instance = new OutboundPlugin()
    })

    it('should not set tags if no precursor tags are available', () => {
      const res = instance.getPeerService({
        fooIsNotAPrecursor: 'bar'
      })
      assert.strictEqual(res, undefined)
    })

    it('should grab from remote host in datadog format', () => {
      const res = instance.getPeerService({
        fooIsNotAPrecursor: 'bar',
        'out.host': 'mypeerservice'
      })
      assert.deepStrictEqual(res, {
        'peer.service': 'mypeerservice',
        '_dd.peer.service.source': 'out.host'
      })
    })

    it('should grab from remote host in OTel format', () => {
      const res = instance.getPeerService({
        fooIsNotAPrecursor: 'bar',
        'net.peer.name': 'mypeerservice'
      })
      assert.deepStrictEqual(res, {
        'peer.service': 'mypeerservice',
        '_dd.peer.service.source': 'net.peer.name'
      })
    })

    it('should use specific tags in order of precedence if they are available', () => {
      class WithPrecursors extends OutboundPlugin {
        static peerServicePrecursors = ['foo', 'bar']
      }
      const res = new WithPrecursors().getPeerService({
        fooIsNotAPrecursor: 'bar',
        bar: 'barPeerService',
        foo: 'fooPeerService'
      })
      assert.deepStrictEqual(res, {
        'peer.service': 'fooPeerService',
        '_dd.peer.service.source': 'foo'
      })
    })
  })

  describe('remapping computation', () => {
    let instance = null
    let mappingStub = null
    const peerData = {
      'peer.service': 'foosvc',
      '_dd.peer.service.source': 'out.host'
    }

    beforeEach(() => {
      instance = new OutboundPlugin()
    })

    afterEach(() => {
      mappingStub.restore()
    })

    it('should return peer data unchanged if there is no peer service', () => {
      mappingStub = sinon.stub(instance, '_tracerConfig').value({})
      const mappingData = instance.getPeerServiceRemap({ foo: 'bar' })
      assert.deepStrictEqual(mappingData, { foo: 'bar' })
    })

    it('should return peer data unchanged if no mapping is available', () => {
      mappingStub = sinon.stub(instance, '_tracerConfig').value({ peerServiceMapping: {} })
      const mappingData = instance.getPeerServiceRemap(peerData)
      assert.deepStrictEqual(mappingData, peerData)
    })

    it('should return peer data unchanged if no mapping item matches', () => {
      mappingStub = sinon.stub(instance, '_tracerConfig').value({
        peerServiceMapping: {
          barsvc: 'bar',
          bazsvc: 'baz'
        }
      })
      const mappingData = instance.getPeerServiceRemap(peerData)
      assert.deepStrictEqual(mappingData, peerData)
    })

    it('should remap if a mapping item matches', () => {
      mappingStub = sinon.stub(instance, '_tracerConfig').value({
        peerServiceMapping: {
          foosvc: 'foo',
          bazsvc: 'baz'
        }
      })
      const mappingData = instance.getPeerServiceRemap(peerData)
      assert.deepStrictEqual(mappingData, {
        'peer.service': 'foo',
        '_dd.peer.service.source': 'out.host',
        '_dd.peer.service.remapped_from': 'foosvc'
      })
    })
  })

  describe('code origin tags', () => {
    let instance = null

    beforeEach(() => {
      const tracerStub = {
        _tracer: {
          startSpan: sinon.stub().returns({
            addTags: sinon.spy()
          })
        }
      }
      instance = new OutboundPlugin(tracerStub)
    })

    describe('disabled', () => {
      const configs = [
        { codeOriginForSpans: { enabled: false, experimental: { exit_spans: { enabled: false } } } },
        { codeOriginForSpans: { enabled: false, experimental: { exit_spans: { enabled: true } } } },
        { codeOriginForSpans: { enabled: true, experimental: { exit_spans: { enabled: false } } } }
      ]

      for (const config of configs) {
        it(`should not add exit tags to span if ${JSON.stringify(config)}`, () => {
          sinon.stub(instance, '_tracerConfig').value(config)
          const span = instance.startSpan('test')
          sinon.assert.notCalled(span.addTags)
        })
      }
    })

    describe('enabled', () => {
      const config = { codeOriginForSpans: { enabled: true, experimental: { exit_spans: { enabled: true } } } }

      it(`should add exit tags to span if ${JSON.stringify(config)}`, () => {
        sinon.stub(instance, '_tracerConfig').value(config)

        const lineNumber = String(getNextLineNumber())
        const span = instance.startSpan('test')

        sinon.assert.calledOnce(span.addTags)
        const args = span.addTags.args[0]
        assert.strictEqual(args.length, 1)
        const tags = parseTags(args[0])

        expect(tags).to.nested.include({ '_dd.code_origin.type': 'exit' })
        assert.ok(Array.isArray(tags._dd.code_origin.frames))
        assert.ok(tags._dd.code_origin.frames.length > 0)

        for (const frame of tags._dd.code_origin.frames) {
          assert.strictEqual(frame.file, __filename)
          assert.ok(Object.hasOwn(frame, 'line'))
          assert.match(frame.line, /^\d+$/)
          assert.ok(Object.hasOwn(frame, 'column'))
          assert.match(frame.column, /^\d+$/)
          assert.ok(Object.hasOwn(frame, 'type'))
          assert.ok(typeof frame.type === 'string')
        }

        const topFrame = tags._dd.code_origin.frames[0]
        assert.strictEqual(topFrame.line, lineNumber)
      })
    })
  })
})
