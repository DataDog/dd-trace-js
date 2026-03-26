'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const dc = require('dc-polyfill')

const { storage } = require('../../../../datadog-core')
const { APPSEC_FS_STORAGE, AppsecFsPlugin } = require('../../../src/appsec/rasp/fs-plugin')
const agent = require('../../plugins/agent')
const { assertObjectContains } = require('../../../../../integration-tests/helpers')

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
        '../../plugins/plugin': PluginClass,
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
      storage(APPSEC_FS_STORAGE).enterWith(undefined)

      let store = appsecFsPlugin._onFsOperationStart()

      assert.strictEqual(store.parentStore, undefined)
      assert.strictEqual(store.root, true)

      store = appsecFsPlugin._onFsOperationFinishOrRenderEnd()

      assert.strictEqual(store, undefined)
    })

    it('should mark fs children', () => {
      const origStore = { orig: true }
      storage(APPSEC_FS_STORAGE).enterWith(origStore)

      const rootStore = appsecFsPlugin._onFsOperationStart()

      assert.strictEqual(rootStore.parentStore, origStore)
      assert.strictEqual(rootStore.root, true)

      storage(APPSEC_FS_STORAGE).enterWith(rootStore)

      let store = appsecFsPlugin._onFsOperationStart()

      assertObjectContains(store, {
        parentStore: rootStore,
        root: false,
        orig: true,
      })

      storage(APPSEC_FS_STORAGE).enterWith(store)

      store = appsecFsPlugin._onFsOperationFinishOrRenderEnd()

      assert.strictEqual(store, rootStore)

      storage(APPSEC_FS_STORAGE).enterWith(store)

      store = appsecFsPlugin._onFsOperationFinishOrRenderEnd()
      assert.strictEqual(store, origStore)
    })
  })

  describe('_onResponseRenderStart', () => {
    it('should mark fs ops as excluded while response rendering', () => {
      appsecFsPlugin.enable()

      storage(APPSEC_FS_STORAGE).enterWith(undefined)

      let store = appsecFsPlugin._onResponseRenderStart()

      assert.strictEqual(store.parentStore, undefined)
      assert.strictEqual(store.opExcluded, true)

      storage(APPSEC_FS_STORAGE).enterWith(store)

      store = appsecFsPlugin._onFsOperationFinishOrRenderEnd()

      assert.strictEqual(store, undefined)
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
          const store = storage(APPSEC_FS_STORAGE).getStore()
          assert.notStrictEqual(store, null)

          count++
          assert.strictEqual(count === 1, store.root)
        }

        try {
          storage(APPSEC_FS_STORAGE).enterWith(undefined)

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
          const store = storage(APPSEC_FS_STORAGE).getStore()
          assert.notStrictEqual(store, null)

          count++
          assert.strictEqual(store.root, undefined)
        }

        try {
          storage(APPSEC_FS_STORAGE).enterWith({ opExcluded: true })

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
          const store = storage(APPSEC_FS_STORAGE).getStore()
          count--

          if (count === 0) {
            assert.strictEqual(store, undefined)
          }
        }
        try {
          storage(APPSEC_FS_STORAGE).enterWith(undefined)

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
