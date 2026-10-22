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
const tracedStore = { span: {} }

describe('AppsecFsPlugin', () => {
  let appsecFsPlugin

  beforeEach(() => {
    appsecFsPlugin = new AppsecFsPlugin()
    appsecFsPlugin.enable()
  })

  afterEach(() => { appsecFsPlugin.disable() })

  describe('enable/disable', () => {
    const channels = [
      opStartCh,
      opFinishCh,
      dc.channel('tracing:datadog:express:response:render:start'),
      dc.channel('tracing:datadog:express:response:render:end'),
    ]
    let fsPlugin, bindStore, unbindStore

    beforeEach(() => {
      bindStore = channels.map(channel => sinon.spy(channel, 'bindStore'))
      unbindStore = channels.map(channel => sinon.spy(channel, 'unbindStore'))

      fsPlugin = proxyquire('../../../src/appsec/rasp/fs-plugin', {})
    })

    afterEach(() => { sinon.restore() })

    function assertEachCalledOnceWith (spies, ...args) {
      for (const spy of spies) {
        sinon.assert.calledOnceWithExactly(spy, ...args)
      }
    }

    function assertNoneCalled (spies) {
      for (const spy of spies) {
        sinon.assert.notCalled(spy)
      }
    }

    it('should require valid mod when calling enable', () => {
      fsPlugin.enable('iast')

      assertEachCalledOnceWith(bindStore, storage(APPSEC_FS_STORAGE), sinon.match.func)
    })

    it('should create only one instance', () => {
      fsPlugin.enable('iast')
      fsPlugin.enable('iast')
      fsPlugin.enable('rasp')

      assertEachCalledOnceWith(bindStore, storage(APPSEC_FS_STORAGE), sinon.match.func)
    })

    it('should discard unknown mods when enabled', () => {
      fsPlugin.enable('unknown')
      assertNoneCalled(bindStore)

      fsPlugin.enable()
      assertNoneCalled(bindStore)
    })

    it('should not disable if there are still modules using the plugin', () => {
      fsPlugin.enable('iast')
      fsPlugin.enable('rasp')

      fsPlugin.disable('rasp')

      assertNoneCalled(unbindStore)
    })

    it('should disable only if there are no more modules using the plugin', () => {
      fsPlugin.enable('iast')
      fsPlugin.enable('rasp')

      fsPlugin.disable('rasp')
      fsPlugin.disable('iast')

      assertEachCalledOnceWith(unbindStore, storage(APPSEC_FS_STORAGE))
    })

    it('should discard unknown mods when disabling', () => {
      fsPlugin.disable('unknown')
      assertNoneCalled(unbindStore)

      fsPlugin.disable()
      assertNoneCalled(unbindStore)
    })
  })

  describe('_onFsOperationStart', () => {
    it('should return fs root', () => {
      storage('legacy').enterWith(tracedStore)
      storage(APPSEC_FS_STORAGE).enterWith(undefined)

      let store = appsecFsPlugin._onFsOperationStart()

      assert.strictEqual(store.parentStore, undefined)
      assert.strictEqual(store.root, true)

      store = appsecFsPlugin._onFsOperationFinishOrRenderEnd()

      assert.strictEqual(store, undefined)
    })

    it('should mark fs children', () => {
      const origStore = { orig: true }
      storage('legacy').enterWith(tracedStore)
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

    it('should not track operations outside of a traced context', () => {
      storage('legacy').enterWith(undefined)
      storage(APPSEC_FS_STORAGE).enterWith({ root: true })

      assert.strictEqual(appsecFsPlugin._onFsOperationStart(), undefined)
    })

    it('should not track operations in a noop context', () => {
      storage('legacy').enterWith({ noop: true })
      storage(APPSEC_FS_STORAGE).enterWith({ root: true })

      assert.strictEqual(appsecFsPlugin._onFsOperationStart(), undefined)
    })
  })

  describe('_onResponseRenderStart', () => {
    it('should mark fs ops as excluded while response rendering', () => {
      appsecFsPlugin.enable()

      storage('legacy').enterWith(tracedStore)
      storage(APPSEC_FS_STORAGE).enterWith(undefined)

      let store = appsecFsPlugin._onResponseRenderStart()

      assert.strictEqual(store.parentStore, undefined)
      assert.strictEqual(store.opExcluded, true)

      storage(APPSEC_FS_STORAGE).enterWith(store)

      store = appsecFsPlugin._onFsOperationFinishOrRenderEnd()

      assert.strictEqual(store, undefined)
    })

    it('should not mark fs ops as excluded outside of a traced context', () => {
      storage('legacy').enterWith(undefined)
      storage(APPSEC_FS_STORAGE).enterWith(undefined)

      assert.strictEqual(appsecFsPlugin._onResponseRenderStart(), undefined)
    })
  })

  describe('integration', () => {
    describe('apm:fs:operation', () => {
      let fs

      afterEach(() => agent.close())

      beforeEach(async () => {
        await agent.load([], undefined, { flushInterval: 1 })
        fs = require('fs')
      })

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

          storage('legacy').run(tracedStore, () => fs.readFileSync(path.join(__dirname, 'fs-plugin.spec.js')))

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

          storage('legacy').run(tracedStore, () => fs.readFileSync(path.join(__dirname, 'fs-plugin.spec.js')))

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

          storage('legacy').run(tracedStore, () => fs.readFileSync(path.join(__dirname, 'fs-plugin.spec.js')))

          assert.strictEqual(count, 0)
        } finally {
          opFinishCh.unsubscribe(onFinish)
        }
      })

      it('should not leak state into callbacks of fs streams started outside of a traced context', async () => {
        storage('legacy').enterWith(undefined)
        storage(APPSEC_FS_STORAGE).enterWith(undefined)

        const roots = await new Promise((resolve, reject) => {
          fs.createReadStream(__filename).on('error', reject).resume().on('end', () => {
            // A server started from this callback handles its requests in this async context.
            const captured = []
            const onStart = () => {
              captured.push(storage(APPSEC_FS_STORAGE).getStore()?.root)
            }

            opStartCh.subscribe(onStart)
            try {
              storage('legacy').run(tracedStore, () => fs.readFileSync(__filename))
              resolve(captured)
            } catch (error) {
              reject(error)
            } finally {
              opStartCh.unsubscribe(onStart)
            }
          })
        })

        assert.deepStrictEqual(roots, [true, false, false, false])
      })
    })

    describe('apm:fs:operation with the tracing fs plugin enabled', () => {
      let fs
      let tracer

      afterEach(() => agent.close())

      beforeEach(async () => {
        tracer = await agent.load('fs', undefined, { flushInterval: 1 })
        fs = require('fs')
      })

      function assertBothPluginsTrackOperation () {
        const roots = []
        const onStart = () => {
          roots.push(storage(APPSEC_FS_STORAGE).getStore()?.root)
        }

        const promise = agent.assertSomeTraces(traces => {
          const parent = traces[0].find(span => span.name === 'parent')
          const readFileSpan = traces[0].find(span => span.resource === 'readFileSync')

          assertObjectContains(readFileSpan, { name: 'fs.operation', parent_id: parent.span_id })
        })

        try {
          storage(APPSEC_FS_STORAGE).enterWith(undefined)

          opStartCh.subscribe(onStart)

          tracer.trace('parent', () => {
            fs.readFileSync(path.join(__dirname, 'fs-plugin.spec.js'))
          })
        } finally {
          opStartCh.unsubscribe(onStart)
        }

        assert.deepStrictEqual(roots, [true, false, false, false])

        return promise
      }

      it('should keep its state when enabled before the tracing fs plugin', () => {
        return assertBothPluginsTrackOperation()
      })

      it('should keep its state when enabled after the tracing fs plugin', () => {
        appsecFsPlugin.disable()
        appsecFsPlugin.enable()

        return assertBothPluginsTrackOperation()
      })
    })
  })
})
