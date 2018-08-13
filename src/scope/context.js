'use strict'

class Context {
  constructor () {
    this._parent = null
    this._count = 0
  }

  retain () {
    this._count++
  }

  release () {
    this._count--

    if (this._count === 0) {
      this._destroy()
    }
  }

  parent () {
    return this._parent
  }

  link (parent) {
    const oldParent = this._parent

    this._parent = parent
    this._parent.attach(this)

    oldParent && oldParent.detach(this)
  }

  unlink () {
    if (this._parent) {
      this._parent.detach(this)
      this._parent = null
    }
  }

  _destroy () {
    this.unlink()
  }
}

module.exports = Context
