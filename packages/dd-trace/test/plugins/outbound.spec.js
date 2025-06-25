'use strict'

const t = require('tap')
require('../setup/core')

const { expect } = require('chai')
const { getNextLineNumber } = require('./helpers')
const OutboundPlugin = require('../../src/plugins/outbound')
const parseTags = require('../../../datadog-core/src/utils/src/parse-tags')

t.test('OuboundPlugin', t => {
  t.test('peer service decision', t => {
    let instance = null
    let computePeerServiceStub = null
    let getPeerServiceStub = null
    let getRemapStub = null

    t.beforeEach(() => {
      instance = new OutboundPlugin()
      computePeerServiceStub = sinon.stub(instance, '_tracerConfig')
      getPeerServiceStub = sinon.stub(instance, 'getPeerService')
      getRemapStub = sinon.stub(instance, 'getPeerServiceRemap')
    })

    t.afterEach(() => {
      computePeerServiceStub.restore()
      getPeerServiceStub.restore()
      getRemapStub.restore()
    })

    t.test('should attempt to remap when we found peer service', t => {
      computePeerServiceStub.value({ spanComputePeerService: true })
      getPeerServiceStub.returns({ foo: 'bar' })
      instance.tagPeerService({ context: () => { return { _tags: {} } }, addTags: () => {} })

      expect(getPeerServiceStub).to.be.called
      expect(getRemapStub).to.be.called
      t.end()
    })

    t.test('should not attempt to remap if we found no peer service', t => {
      computePeerServiceStub.value({ spanComputePeerService: true })
      getPeerServiceStub.returns(undefined)
      instance.tagPeerService({ context: () => { return { _tags: {} } }, addTags: () => {} })

      expect(getPeerServiceStub).to.be.called
      expect(getRemapStub).to.not.be.called
      t.end()
    })

    t.test('should do nothing when disabled', t => {
      computePeerServiceStub.value({ spanComputePeerService: false })
      instance.tagPeerService({ context: () => { return { _tags: {} } }, addTags: () => {} })
      expect(getPeerServiceStub).to.not.be.called
      expect(getRemapStub).to.not.be.called
      t.end()
    })
    t.end()
  })

  t.test('peer.service computation', t => {
    let instance = null

    t.before(() => {
      instance = new OutboundPlugin()
    })

    t.test('should not set tags if no precursor tags are available', t => {
      const res = instance.getPeerService({
        fooIsNotAPrecursor: 'bar'
      })
      expect(res).to.equal(undefined)
      t.end()
    })

    t.test('should grab from remote host in datadog format', t => {
      const res = instance.getPeerService({
        fooIsNotAPrecursor: 'bar',
        'out.host': 'mypeerservice'
      })
      expect(res).to.deep.equal({
        'peer.service': 'mypeerservice',
        '_dd.peer.service.source': 'out.host'
      })
      t.end()
    })

    t.test('should grab from remote host in OTel format', t => {
      const res = instance.getPeerService({
        fooIsNotAPrecursor: 'bar',
        'net.peer.name': 'mypeerservice'
      })
      expect(res).to.deep.equal({
        'peer.service': 'mypeerservice',
        '_dd.peer.service.source': 'net.peer.name'
      })
      t.end()
    })

    t.test('should use specific tags in order of precedence if they are available', t => {
      class WithPrecursors extends OutboundPlugin {
        static get peerServicePrecursors () { return ['foo', 'bar'] }
      }
      const res = new WithPrecursors().getPeerService({
        fooIsNotAPrecursor: 'bar',
        bar: 'barPeerService',
        foo: 'fooPeerService'
      })
      expect(res).to.deep.equal({
        'peer.service': 'fooPeerService',
        '_dd.peer.service.source': 'foo'
      })
      t.end()
    })
    t.end()
  })

  t.test('remapping computation', t => {
    let instance = null
    let mappingStub = null
    const peerData = {
      'peer.service': 'foosvc',
      '_dd.peer.service.source': 'out.host'
    }

    t.beforeEach(() => {
      instance = new OutboundPlugin()
    })

    t.afterEach(() => {
      mappingStub.restore()
    })

    t.test('should return peer data unchanged if there is no peer service', t => {
      mappingStub = sinon.stub(instance, '_tracerConfig').value({})
      const mappingData = instance.getPeerServiceRemap({ foo: 'bar' })
      expect(mappingData).to.deep.equal({ foo: 'bar' })
      t.end()
    })

    t.test('should return peer data unchanged if no mapping is available', t => {
      mappingStub = sinon.stub(instance, '_tracerConfig').value({ peerServiceMapping: {} })
      const mappingData = instance.getPeerServiceRemap(peerData)
      expect(mappingData).to.deep.equal(peerData)
      t.end()
    })

    t.test('should return peer data unchanged if no mapping item matches', t => {
      mappingStub = sinon.stub(instance, '_tracerConfig').value({
        peerServiceMapping: {
          barsvc: 'bar',
          bazsvc: 'baz'
        }
      })
      const mappingData = instance.getPeerServiceRemap(peerData)
      expect(mappingData).to.deep.equal(peerData)
      t.end()
    })

    t.test('should remap if a mapping item matches', t => {
      mappingStub = sinon.stub(instance, '_tracerConfig').value({
        peerServiceMapping: {
          foosvc: 'foo',
          bazsvc: 'baz'
        }
      })
      const mappingData = instance.getPeerServiceRemap(peerData)
      expect(mappingData).to.deep.equal({
        'peer.service': 'foo',
        '_dd.peer.service.source': 'out.host',
        '_dd.peer.service.remapped_from': 'foosvc'
      })
      t.end()
    })
    t.end()
  })

  t.test('code origin tags', t => {
    let instance = null

    t.beforeEach(() => {
      const tracerStub = {
        _tracer: {
          startSpan: sinon.stub().returns({
            addTags: sinon.spy()
          })
        }
      }
      instance = new OutboundPlugin(tracerStub)
    })

    t.test('disabled', t => {
      const configs = [
        { codeOriginForSpans: { enabled: false, experimental: { exit_spans: { enabled: false } } } },
        { codeOriginForSpans: { enabled: false, experimental: { exit_spans: { enabled: true } } } },
        { codeOriginForSpans: { enabled: true, experimental: { exit_spans: { enabled: false } } } }
      ]

      for (const config of configs) {
        t.test(`should not add exit tags to span if ${JSON.stringify(config)}`, t => {
          sinon.stub(instance, '_tracerConfig').value(config)
          const span = instance.startSpan('test')
          expect(span.addTags).to.not.have.been.called
          t.end()
        })
      }
      t.end()
    })

    t.test('enabled', t => {
      const config = { codeOriginForSpans: { enabled: true, experimental: { exit_spans: { enabled: true } } } }

      t.test(`should add exit tags to span if ${JSON.stringify(config)}`, t => {
        sinon.stub(instance, '_tracerConfig').value(config)

        const lineNumber = String(getNextLineNumber())
        const span = instance.startSpan('test')

        expect(span.addTags).to.have.been.calledOnce
        const args = span.addTags.args[0]
        expect(args).to.have.property('length', 1)
        const tags = parseTags(args[0])

        expect(tags).to.nested.include({ '_dd.code_origin.type': 'exit' })
        expect(tags._dd.code_origin).to.have.property('frames').to.be.an('array').with.length.above(0)

        for (const frame of tags._dd.code_origin.frames) {
          expect(frame).to.have.property('file', __filename)
          expect(frame).to.have.property('line').to.match(/^\d+$/)
          expect(frame).to.have.property('column').to.match(/^\d+$/)
          expect(frame).to.have.property('type').to.a('string')
        }

        const topFrame = tags._dd.code_origin.frames[0]
        expect(topFrame).to.have.property('line', lineNumber)
        t.end()
      })
      t.end()
    })
    t.end()
  })
  t.end()
})
