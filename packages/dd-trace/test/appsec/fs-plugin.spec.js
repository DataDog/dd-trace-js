'use strict'

const { assert } = require('chai')
const path = require('path')
const dc = require('dc-polyfill')
const { storage } = require('../../../datadog-core')
const { AppsecFsPlugin } = require('../../src/appsec/fs-plugin')
const agent = require('../plugins/agent')

const opStartCh = dc.channel('apm:fs:operation:start')
const opFinishCh = dc.channel('apm:fs:operation:finish')

describe('AppsecFsPlugin', () => {
  let plugin

  beforeEach(() => {
    plugin = new AppsecFsPlugin()
    plugin.enable()
  })

  afterEach(() => { plugin.disable() })

  it('should mark fs root', () => {
    const origStore = {}
    storage.enterWith(origStore)

    plugin._onFsOperationStart()

    let store = storage.getStore()
    assert.property(store, 'fs')
    assert.propertyVal(store.fs, 'parentStore', origStore)
    assert.propertyVal(store.fs, 'root', true)

    plugin._onFsOperationFinishOrRenderEnd()

    store = storage.getStore()
    assert.equal(store, origStore)
    assert.notProperty(store, 'fs')
  })

  it('should mark fs children', () => {
    const origStore = { orig: true }
    storage.enterWith(origStore)

    plugin._onFsOperationStart()

    const rootStore = storage.getStore()
    assert.property(rootStore, 'fs')
    assert.propertyVal(rootStore.fs, 'parentStore', origStore)
    assert.propertyVal(rootStore.fs, 'root', true)

    plugin._onFsOperationStart()

    let store = storage.getStore()
    assert.property(store, 'fs')
    assert.propertyVal(store.fs, 'parentStore', rootStore)
    assert.propertyVal(store.fs, 'root', false)
    assert.propertyVal(store, 'orig', true)

    plugin._onFsOperationFinishOrRenderEnd()

    store = storage.getStore()
    assert.equal(store, rootStore)

    plugin._onFsOperationFinishOrRenderEnd()
    store = storage.getStore()
    assert.equal(store, origStore)
  })

  it('should mark fs ops as excluded while response rendering', () => {
    plugin.enable()

    const origStore = {}
    storage.enterWith(origStore)

    plugin._onResponseRenderStart()

    let store = storage.getStore()
    assert.property(store, 'fs')
    assert.propertyVal(store.fs, 'parentStore', origStore)
    assert.propertyVal(store.fs, 'opExcluded', true)

    plugin._onFsOperationFinishOrRenderEnd()

    store = storage.getStore()
    assert.equal(store, origStore)
    assert.notProperty(store, 'fs')
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
          const store = storage.getStore()
          assert.isNotNull(store.fs)

          count++
          assert.strictEqual(count === 1, store.fs.root)
        }

        try {
          const origStore = {}
          storage.enterWith(origStore)

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
          const store = storage.getStore()
          assert.isNotNull(store.fs)

          count++
          assert.isUndefined(store.fs.root)
        }

        try {
          const origStore = {
            fs: { opExcluded: true }
          }
          storage.enterWith(origStore)

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
          const store = storage.getStore()
          count--

          if (count === 0) {
            assert.isUndefined(store.fs)
          }
        }
        try {
          const origStore = {}
          storage.enterWith(origStore)

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
