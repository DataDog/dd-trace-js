const leaves = require('./internals')

class Dummy {
  constructor () {
    this.contents = {}
    this._leaves = leaves
  }

  get leaves () {
    return this._leaves
  }

  configure (contents) {
    this.contents = contents
  }
}

module.exports = new Dummy()
