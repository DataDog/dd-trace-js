'use strict'

const sym = Symbol.for('dd-trace')

if (!globalThis[sym]) {
  Object.defineProperty(globalThis, sym, {
    value: {
      instrumentations: {},
      beforeExitHandlers: new Set(),
    },
    enumerable: false,
    configurable: false,
    writable: false
  })
}

process.once('beforeExit', () => {
  for (const handler of globalThis[sym].beforeExitHandlers) {
    handler()
  }
})

module.exports = globalThis[sym].instrumentations
