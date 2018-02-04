'use strict'

const context = require('./cls')

module.exports = () => ({
  run (callback) {
    context.run(() => {
      if (!context.get('trace')) {
        context.set('trace', [])
        context.set('finished_count', 0)
      }

      callback(context.get('span'))
    })
  },

  span () {
    return context.get('span')
  },

  bind (callback) {
    return context.bind(callback)
  },

  bindEmitter (emitter) {
    context.bindEmitter(emitter)
  },

  _get (key) {
    return context.get(key)
  },

  _set (key, value) {
    return context.set(key, value)
  }
})
