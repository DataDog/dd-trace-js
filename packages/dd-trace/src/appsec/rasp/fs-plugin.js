'use strict'

const Plugin = require('../../plugins/plugin')
const { storage } = require('../../../../datadog-core')
const log = require('../../log')

const RASP_MODULE = 'rasp'
const IAST_MODULE = 'iast'

const enabledFor = {
  [RASP_MODULE]: false,
  [IAST_MODULE]: false
}

let fsPlugin

function getStoreToStart (fsProps, store = storage('legacy').getStore()) {
  if (store && !store.fs?.opExcluded) {
    return {
      ...store,
      fs: {
        ...store.fs,
        ...fsProps,
        parentStore: store
      }
    }
  }

  return store
}

class AppsecFsPlugin extends Plugin {
  enable () {
    this.addBind('apm:fs:operation:start', this._onFsOperationStart)
    this.addBind('apm:fs:operation:finish', this._onFsOperationFinishOrRenderEnd)
    this.addBind('tracing:datadog:express:response:render:start', this._onResponseRenderStart)
    this.addBind('tracing:datadog:express:response:render:end', this._onFsOperationFinishOrRenderEnd)

    super.configure(true)
  }

  disable () {
    super.configure(false)
  }

  _onFsOperationStart () {
    const store = storage('legacy').getStore()
    if (store) {
      return getStoreToStart({ root: store.fs?.root === undefined }, store)
    }
  }

  _onResponseRenderStart () {
    return getStoreToStart({ opExcluded: true })
  }

  _onFsOperationFinishOrRenderEnd () {
    const store = storage('legacy').getStore()
    if (store?.fs) {
      return store.fs.parentStore
    }
    return store
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

  RASP_MODULE,
  IAST_MODULE
}
