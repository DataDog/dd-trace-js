'use strict'

const Plugin = require('../plugins/plugin')
const { storage } = require('../../../datadog-core')

let fsPlugin

class AppsecFsPlugin extends Plugin {
  enable () {
    this.addSub('apm:fs:operation:start', this._onFsOperationStart)
    this.addSub('apm:fs:operation:finish', this._onFsOperationFinish)
    this.addSub('tracing:datadog:express:response:render:start', this._onResponseRenderStart)
    this.addSub('tracing:datadog:express:response:render:end', this._onResponseRenderEnd)

    super.configure(true)
  }

  _onFsOperationStart (obj) {
    const store = storage.getStore()
    if (store) {
      storage.enterWith({
        ...store,
        fs: {
          root: store.fs === undefined, // nested fs.operation should have fs property
          parentStore: store
        }
      })
    }
  }

  _onFsOperationFinish () {
    const store = storage.getStore()
    if (store?.fs?.parentStore) {
      storage.enterWith(store.fs.parentStore)
    }
  }

  _onResponseRenderStart () {
    const store = storage.getStore()
    if (store) {
      storage.enterWith({
        ...store,
        resRendering: true
      })
    }
  }

  _onResponseRenderEnd () {
    const store = storage.getStore()
    if (store) {
      delete store.resRendering // NOTE: is it OK?
      storage.enterWith(store)
    }
  }
}

function enable () {
  if (fsPlugin) return

  fsPlugin = new AppsecFsPlugin()
  fsPlugin.enable()
}

function disable () {
  // FIXME: AppsecFsPlugin could be used by appsec and iast
  fsPlugin.configure(false)

  fsPlugin = undefined
}

module.exports = {
  enable,
  disable
}
