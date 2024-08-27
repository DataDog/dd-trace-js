'use strict'

const Plugin = require('../plugins/plugin')
const { storage } = require('../../../datadog-core')

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
      enterWith({ root: store.fs?.root === undefined }, store) // could be used opExcluded flag instead root flag?
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

function enable () {
  if (fsPlugin) return

  fsPlugin = new AppsecFsPlugin()
  fsPlugin.enable()
}

function disable () {
  if (!fsPlugin) return

  // FIXME: AppsecFsPlugin could be used by appsec and iast
  fsPlugin.disable()

  fsPlugin = undefined
}

module.exports = {
  enable,
  disable,

  AppsecFsPlugin
}
