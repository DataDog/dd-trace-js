'use strict'

class Loader {
  constructor (instrumenter) {
    this._instrumenter = instrumenter
  }

  reload (plugins) {
    plugins.forEach((meta, plugin) => {
      this._instrumenter.unload(plugin)
      this._instrumenter.load(plugin, meta)
    })
  }

  getModules (instrumentation) {
    return [window[instrumentation.name]]
  }
}

module.exports = Loader
