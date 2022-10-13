'use strict'

const ClientPlugin = require('./client')

class StoragePlugin extends ClientPlugin {
  constructor (...args) {
    super(...args)

    this.system = this.constructor.system || this.component
  }

  startSpan (name, options) {
    if (!options.service && this.system) {
      options.service = `${this.tracer._service}-${this.system}`
    }

    return super.startSpan(name, options)
  }
}

module.exports = StoragePlugin
