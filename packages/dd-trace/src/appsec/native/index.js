'use strict'

const crypto = require('crypto')
const util = require('../../util')
const nativeLib = util.loadWAF()

class LibAppSec {
  static clearAll () {
    nativeLib.clearAll()
  }

  static version () {
    nativeLib.version()
  }

  constructor (wafRule) {
    this.id = crypto.randomBytes(15).toString('base64') // get a random id, would be better with uuid
    nativeLib.init(this.id, wafRule)
    this.cleared = false
  }

  /**
   *
   * @param {Object} inputs
   * @param {number} timeout in microseconds (warning MICROseconds)
   */
  run (inputs, timeout) {
    if (this.cleared) {
      throw new Error('calling a cleared instance of appsecLib')
    }

    return nativeLib.run(this.id, inputs, timeout)
  }

  clear () {
    nativeLib.clear(this.id)
    this.cleared = true
  }
}

module.exports = {
  LibAppSec
}
