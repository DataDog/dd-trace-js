'use strict'

const dc = require('dc-polyfill')

const Plugin = require('../src')
const NoopProxy = require('../../dd-trace/src/noop/proxy')
const assert = require('assert')

describe('Plugin', () => {
  describe('dd-trace-api', () => {
    let dummyTracer
    let plugin
    let tracer
    let scope

    const allChannels = new Set()
    const testedChannels = new Set()

    function test({name, fn, self = dummyTracer, ret = undefined, args = []}) {
      testedChannels.add('datadog-api:v1:' + name)
      const ch = dc.channel('datadog-api:v1:' + name)
      const payload = {
        self,
        args: [],
        ret: {},
        proxy: () => ret,
        revProxy: []
      }
      ch.publish(payload)
      expect(payload.ret.value).to.equal(ret)
      expect(fn).to.have.been.calledOnceWithExactly(...args)
    }

    before(() => {
      sinon.spy(dc, 'channel')

      tracer = new NoopProxy()
      scope = tracer._tracer._scope
      sinon.spy(scope)
      sinon.spy(tracer)
      plugin = new Plugin(tracer, {})
      plugin.configure(true)

      for (let i = 0; i < dc.channel.callCount; i++) {
        const call = dc.channel.getCall(i)
        const channel = call.args[0]
        allChannels.add(channel)
      }

      dummyTracer = {}
      const payload = {
        proxy: () => dummyTracer,
        args: []
      }
      dc.channel('datadog-api:v1:tracerinit').publish(payload)
    })

    describe('scope', () => {
      let dummyScope
      it('should call underlying api', () => {
        dummyScope = {}
        test({name: 'scope', fn: tracer.scope, ret: dummyScope})
      })

//       describe('scope:active', () => {
//         it('should call underlying api', () => {
//           const scope = tracer.scope()
//           test({name: 'scope:active', fn: tracer._scope.active, self: scope, ret: null})
//         })
//       })
//
//       describe('scope:activate', () => {
//         it('should call underlying api', () => {
//           const scope = tracer.scope()
//           test({name: 'scope:activate', fn: tracer._scope.active, self: scope})
//         })
//       })
//
//       describe('scope:bind', () => {
//         it('should call underlying api', () => {
//           const dummyScope = tracer.scope()
//           test({name: 'scope:bind', fn: tracer._scope.active, self: scope})
//         })
//       })

    })


    after('dd-trace-api all events tested', () => {
      // TODO uncomment next line when all are tested
      // assert.deepStrictEqual([...allChannels].sort(), [...testedChannels].sort())
    })
  })
})

