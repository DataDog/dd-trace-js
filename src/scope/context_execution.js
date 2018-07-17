'use strict'

class ContextExecution {
  constructor (context) {
    this._context = context
    this._children = new Set()
    this._active = null
    this._count = 0
    this._exited = false
    this._set = []

    if (context) {
      context.retain()
    }
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
    return this._context ? this._context.parent() : null
  }

  scope () {
    return this._active
  }

  add (scope) {
    this._set.push(scope)
    this._active = scope
  }

  remove (scope) {
    const index = this._set.lastIndexOf(scope)

    this._set.splice(index, 1)
    this._active = this._set[this._set.length - 1] || null
  }

  exit () {
    if (this._context && !this._active) {
      this._bypass()
    }
  }

  attach (child) {
    this._children.add(child)
    this.retain()
  }

  detach (child) {
    this._children.delete(child)
    this.release()
  }

  _close () {
    for (let i = this._set.length - 1; i >= 0; i--) {
      this._set[i].close()
    }
  }

  _destroy () {
    this._close()

    if (this._context) {
      this._context.release()
    }
  }

  _bypass () {
    this._children.forEach(child => child.link(this._context.parent()))
  }
}

module.exports = ContextExecution
