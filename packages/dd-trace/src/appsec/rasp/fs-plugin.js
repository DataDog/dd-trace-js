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

function enterWith (fsProps, store = storage.getStore()) {
  if (store && !store.fs?.opExcluded) {
    storage.enterWith({
      ...store,
      fs: {
        ...store.fs,
        ...fsProps,
        parentStore: store
      }
    })
  }
}

class AppsecFsPlugin extends Plugin {
  enable () {
    this.addSub('apm:fs:operation:start', this._onFsOperationStart)
    this.addSub('apm:fs:operation:finish', this._onFsOperationFinishOrRenderEnd)
    this.addSub('tracing:datadog:express:response:render:start', this._onResponseRenderStart)
    this.addSub('tracing:datadog:express:response:render:end', this._onFsOperationFinishOrRenderEnd)

    super.configure(true)
  }

  disable () {
    super.configure(false)
  }

  _onFsOperationStart () {
    const store = storage.getStore()
    if (store) {
      enterWith({ root: store.fs?.root === undefined }, store)
    }
  }

  _onResponseRenderStart () {
    enterWith({ opExcluded: true })
  }

  _onFsOperationFinishOrRenderEnd () {
    const store = storage.getStore()
    if (store?.fs?.parentStore) {
      storage.enterWith(store.fs.parentStore)
    }
  }
}

function enable (mod) {
  if (enabledFor[mod] !== false) return

  enabledFor[mod] = true

  if (!fsPlugin) {
    fsPlugin = new AppsecFsPlugin()
    fsPlugin.enable()
  }

  log.info(`Enabled AppsecFsPlugin for ${mod}`)
}

function disable (mod) {
  if (!mod || !enabledFor[mod]) return

  enabledFor[mod] = false

  const allDisabled = Object.values(enabledFor).every(val => val === false)
  if (allDisabled) {
    fsPlugin?.disable()

    fsPlugin = undefined
  }

  log.info(`Disabled AppsecFsPlugin for ${mod}`)
}

module.exports = {
  enable,
  disable,

  AppsecFsPlugin,

  RASP_MODULE,
  IAST_MODULE
}
