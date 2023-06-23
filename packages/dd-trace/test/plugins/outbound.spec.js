'use strict'

require('../setup/tap')

const OutboundPlugin = require('../../src/plugins/outbound')

describe('OuboundPlugin', () => {
  describe('peer.service computation', () => {
    let instance = null

    before(() => {
      instance = new OutboundPlugin()
    })

    it('should not set tags if no precursor tags are available', () => {
      const res = instance.getPeerService({
        fooIsNotAPrecursor: 'bar'
      })
      expect(res).to.deep.equal({})
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
})
