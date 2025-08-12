'use strict'

const proxyquire = require('proxyquire')
const { assert } = require('chai')
const path = require('path')
const dc = require('dc-polyfill')
const { storage } = require('../../../../datadog-core')
const { AppsecFsPlugin } = require('../../../src/appsec/rasp/fs-plugin')
const agent = require('../../plugins/agent')

const opStartCh = dc.channel('apm:fs:operation:start')
const opFinishCh = dc.channel('apm:fs:operation:finish')

describe('AppsecFsPlugin', () => {
  let appsecFsPlugin

  beforeEach(() => {
    appsecFsPlugin = new AppsecFsPlugin()
    appsecFsPlugin.enable()
  })

  afterEach(() => { appsecFsPlugin.disable() })

  describe('enable/disable', () => {
    let fsPlugin, configure

    beforeEach(() => {
      configure = sinon.stub()
      class PluginClass {
        addBind (channelName, handler) {}
        addSub (channelName, handler) {}

        configure (config) {
          configure(config)
        }
      }

      fsPlugin = proxyquire('../../../src/appsec/rasp/fs-plugin', {
        '../../plugins/plugin': PluginClass
      })
    })

    afterEach(() => { sinon.restore() })

    it('should require valid mod when calling enable', () => {
      fsPlugin.enable('iast')

      sinon.assert.calledOnceWithExactly(configure, true)
    })

    it('should create only one instance', () => {
      fsPlugin.enable('iast')
      fsPlugin.enable('iast')
      fsPlugin.enable('rasp')

      sinon.assert.calledOnceWithExactly(configure, true)
    })

    it('should discard unknown mods when enabled', () => {
      fsPlugin.enable('unknown')
      sinon.assert.notCalled(configure)

      fsPlugin.enable()
      sinon.assert.notCalled(configure)
    })

    it('should not disable if there are still modules using the plugin', () => {
      fsPlugin.enable('iast')
      fsPlugin.enable('rasp')

      fsPlugin.disable('rasp')

      sinon.assert.calledOnce(configure)
    })

    it('should disable only if there are no more modules using the plugin', () => {
      fsPlugin.enable('iast')
      fsPlugin.enable('rasp')

      fsPlugin.disable('rasp')
      fsPlugin.disable('iast')

      sinon.assert.calledTwice(configure)
      assert.strictEqual(configure.secondCall.args[0], false)
    })

    it('should discard unknown mods when disabling', () => {
      fsPlugin.disable('unknown')
      sinon.assert.notCalled(configure)

      fsPlugin.disable()
      sinon.assert.notCalled(configure)
    })
  })

  describe('_onFsOperationStart', () => {
    it('should return fs root', () => {
      const origStore = {}
      storage('legacy').enterWith(origStore)

      let store = appsecFsPlugin._onFsOperationStart()

      assert.property(store, 'fs')
      assert.propertyVal(store.fs, 'parentStore', origStore)
      assert.propertyVal(store.fs, 'root', true)

      store = appsecFsPlugin._onFsOperationFinishOrRenderEnd()

      assert.equal(store, origStore)
      assert.notProperty(store, 'fs')
    })

    it('should mark fs children', () => {
      const origStore = { orig: true }
      storage('legacy').enterWith(origStore)

      const rootStore = appsecFsPlugin._onFsOperationStart()

      assert.property(rootStore, 'fs')
      assert.propertyVal(rootStore.fs, 'parentStore', origStore)
      assert.propertyVal(rootStore.fs, 'root', true)

      storage('legacy').enterWith(rootStore)

      let store = appsecFsPlugin._onFsOperationStart()

      assert.property(store, 'fs')
      assert.propertyVal(store.fs, 'parentStore', rootStore)
      assert.propertyVal(store.fs, 'root', false)
      assert.propertyVal(store, 'orig', true)

      storage('legacy').enterWith(store)

      store = appsecFsPlugin._onFsOperationFinishOrRenderEnd()

      assert.equal(store, rootStore)

      storage('legacy').enterWith(store)

      store = appsecFsPlugin._onFsOperationFinishOrRenderEnd()
      assert.equal(store, origStore)
    })
  })

  describe('_onResponseRenderStart', () => {
    it('should mark fs ops as excluded while response rendering', () => {
      appsecFsPlugin.enable()

      const origStore = {}
      storage('legacy').enterWith(origStore)

      let store = appsecFsPlugin._onResponseRenderStart()

      assert.property(store, 'fs')
      assert.propertyVal(store.fs, 'parentStore', origStore)
      assert.propertyVal(store.fs, 'opExcluded', true)

      storage('legacy').enterWith(store)

      store = appsecFsPlugin._onFsOperationFinishOrRenderEnd()

      assert.equal(store, origStore)
      assert.notProperty(store, 'fs')
    })
  })

  describe('integration', () => {
    describe('apm:fs:operation', () => {
      let fs

      afterEach(() => agent.close({ ritmReset: false }))

      beforeEach(() => agent.load('fs', undefined, { flushInterval: 1 }).then(() => {
        fs = require('fs')
      }))

      it('should mark root operations', () => {
        let count = 0
        const onStart = () => {
          const store = storage('legacy').getStore()
          assert.isNotNull(store.fs)

          count++
          assert.strictEqual(count === 1, store.fs.root)
        }

        try {
          const origStore = {}
          storage('legacy').enterWith(origStore)

          opStartCh.subscribe(onStart)

          fs.readFileSync(path.join(__dirname, 'fs-plugin.spec.js'))

          assert.strictEqual(count, 4)
        } finally {
          opStartCh.unsubscribe(onStart)
        }
      })

      it('should mark root even if op is excluded', () => {
        let count = 0
        const onStart = () => {
          const store = storage('legacy').getStore()
          assert.isNotNull(store.fs)

          count++
          assert.isUndefined(store.fs.root)
        }

        try {
          const origStore = {
            fs: { opExcluded: true }
          }
          storage('legacy').enterWith(origStore)

          opStartCh.subscribe(onStart)

          fs.readFileSync(path.join(__dirname, 'fs-plugin.spec.js'))

          assert.strictEqual(count, 4)
        } finally {
          opStartCh.unsubscribe(onStart)
        }
      })

      it('should clean up store when finishing op', () => {
        let count = 4
        const onFinish = () => {
          const store = storage('legacy').getStore()
          count--

          if (count === 0) {
            assert.isUndefined(store.fs)
          }
        }
        try {
          const origStore = {}
          storage('legacy').enterWith(origStore)

          opFinishCh.subscribe(onFinish)

          fs.readFileSync(path.join(__dirname, 'fs-plugin.spec.js'))

          assert.strictEqual(count, 0)
        } finally {
          opFinishCh.unsubscribe(onFinish)
        }
      })
    })
  })
})
