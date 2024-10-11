'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')

class CodeOriginForSpansPlugin extends Plugin {
  static get id () {
    return 'code-origin-for-spans'
  }

  constructor (...args) {
    super(...args)

    if (this._tracerConfig.codeOriginForSpansEnabled) {
      this.instrument()
    }
  }

  instrument () {
    throw new Error('Not implemented')
  }
}

module.exports = CodeOriginForSpansPlugin
