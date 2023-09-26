'use strict'

require('../setup/tap')

const { expect } = require('chai')
const OutboundPlugin = require('../../src/plugins/outbound')

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

      expect(getPeerServiceStub).to.be.called
      expect(getRemapStub).to.be.called
    })

    it('should not attempt to remap if we found no peer service', () => {
      computePeerServiceStub.value({ spanComputePeerService: true })
      getPeerServiceStub.returns(undefined)
      instance.tagPeerService({ context: () => { return { _tags: {} } }, addTags: () => {} })

      expect(getPeerServiceStub).to.be.called
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
      expect(res).to.equal(undefined)
    })

    it('should grab from remote host in datadog format', () => {
      const res = instance.getPeerService({
        fooIsNotAPrecursor: 'bar',
        'out.host': 'mypeerservice'
      })
      expect(res).to.deep.equal({
        'peer.service': 'mypeerservice',
        '_dd.peer.service.source': 'out.host'
      })
    })

    it('should grab from remote host in OTel format', () => {
      const res = instance.getPeerService({
        fooIsNotAPrecursor: 'bar',
        'net.peer.name': 'mypeerservice'
      })
      expect(res).to.deep.equal({
        'peer.service': 'mypeerservice',
        '_dd.peer.service.source': 'net.peer.name'
      })
    })

    it('should use specific tags in order of precedence if they are available', () => {
      class WithPrecursors extends OutboundPlugin {
        static get peerServicePrecursors () { return [ 'foo', 'bar' ] }
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
      const mappingData = instance.getPeerServiceRemap({ 'foo': 'bar' })
      expect(mappingData).to.deep.equal({ 'foo': 'bar' })
    })

    it('should return peer data unchanged if no mapping is available', () => {
      mappingStub = sinon.stub(instance, '_tracerConfig').value({ peerServiceMapping: {} })
      const mappingData = instance.getPeerServiceRemap(peerData)
      expect(mappingData).to.deep.equal(peerData)
    })

    it('should return peer data unchanged if no mapping item matches', () => {
      mappingStub = sinon.stub(instance, '_tracerConfig').value({
        peerServiceMapping: {
          barsvc: 'bar',
          bazsvc: 'baz'
        }
      })
      const mappingData = instance.getPeerServiceRemap(peerData)
      expect(mappingData).to.deep.equal(peerData)
    })

    it('should remap if a mapping item matches', () => {
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
    })
  })
})
