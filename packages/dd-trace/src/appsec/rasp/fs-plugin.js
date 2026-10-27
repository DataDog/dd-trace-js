'use strict'

const dc = require('dc-polyfill')

const { storage } = require('../../../../datadog-core')
const log = require('../../log')

const RASP_MODULE = 'rasp'
const IAST_MODULE = 'iast'
const APPSEC_FS_STORAGE = 'appsec-fs'

const enabledFor = {
  [RASP_MODULE]: false,
  [IAST_MODULE]: false,
}

let fsPlugin
const legacyStorage = storage('legacy')
const appsecFsStorage = storage(APPSEC_FS_STORAGE)
const fsOperationStart = dc.channel('apm:fs:operation:start')
const fsOperationFinish = dc.channel('apm:fs:operation:finish')
const responseRenderStart = dc.channel('tracing:datadog:express:response:render:start')
const responseRenderEnd = dc.channel('tracing:datadog:express:response:render:end')

function getStoreToStart (fsProps, store = appsecFsStorage.getStore()) {
  // Only track operations inside a traced context, like a request. Callbacks of fs streams and watchers keep
  // the state of the operation that created them, so state created outside of one would leak into every request
  // of a server started from such a callback. The tracing fs plugin enters a noop store when no span is active.
  const legacyStore = legacyStorage.getStore()
  if (!legacyStore || legacyStore.noop) return

  if (!store || !store.opExcluded) {
    return {
      ...store,
      ...fsProps,
      parentStore: store,
    }
  }

  return store
}

class AppsecFsPlugin {
  enable () {
    // The tracing fs plugin binds the legacy store on these channels. AppSec
    // keeps its fs-only state in a dedicated storage namespace to avoid
    // clobbering tracing state while still tracking nested operations.
    fsOperationStart.bindStore(appsecFsStorage, this._onFsOperationStart)
    fsOperationFinish.bindStore(appsecFsStorage, this._onFsOperationFinishOrRenderEnd)
    responseRenderStart.bindStore(appsecFsStorage, this._onResponseRenderStart)
    responseRenderEnd.bindStore(appsecFsStorage, this._onFsOperationFinishOrRenderEnd)
  }

  disable () {
    fsOperationStart.unbindStore(appsecFsStorage)
    fsOperationFinish.unbindStore(appsecFsStorage)
    responseRenderStart.unbindStore(appsecFsStorage)
    responseRenderEnd.unbindStore(appsecFsStorage)
  }

  _onFsOperationStart () {
    const store = appsecFsStorage.getStore()

    return getStoreToStart({ root: store?.root === undefined }, store)
  }

  _onResponseRenderStart () {
    return getStoreToStart({ opExcluded: true })
  }

  _onFsOperationFinishOrRenderEnd () {
    return appsecFsStorage.getStore()?.parentStore
  }
}

function enable (mod) {
  if (enabledFor[mod] !== false) return

  enabledFor[mod] = true

  if (!fsPlugin) {
    fsPlugin = new AppsecFsPlugin()
    fsPlugin.enable()
  }

  log.info('[ASM] Enabled AppsecFsPlugin for %s', mod)
}

function disable (mod) {
  if (!mod || !enabledFor[mod]) return

  enabledFor[mod] = false

  const allDisabled = Object.values(enabledFor).every(val => val === false)
  if (allDisabled) {
    fsPlugin?.disable()

    fsPlugin = undefined
  }

  log.info('[ASM] Disabled AppsecFsPlugin for %s', mod)
}

module.exports = {
  enable,
  disable,

  AppsecFsPlugin,
  APPSEC_FS_STORAGE,

  RASP_MODULE,
  IAST_MODULE,
}
