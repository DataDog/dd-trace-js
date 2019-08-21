'use strict'

class Loader {
  reload () {}

  getModules (instrumentation) {
    return [window[instrumentation.name]]
  }
}

module.exports = Loader
