'use strict'

class Dictionary {
  constructor () {
    this.length = 0

    this._strings = []

    this.reset()
  }

  get (value = '') {
    if (!(value in this._map)) {
      this._map[value] = this.length++
      this._strings.push(value)
    }

    return this._map[value]
  }

  reset () {
    this._strings.length = 0
    this._map = {}

    this.length = 0

    this.get('')
  }
}

module.exports = { Dictionary }
