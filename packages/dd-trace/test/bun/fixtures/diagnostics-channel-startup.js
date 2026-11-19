'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')

const probe = dc.channel(Symbol('startup-probe'))
const handler = () => {}
probe.subscribe(handler)
const proto = Object.getPrototypeOf(probe)
probe.unsubscribe(handler)

const scenario = process.argv[2]
if (scenario === 'frozen') {
  Object.freeze(proto)
} else if (scenario === 'read-only') {
  Object.defineProperty(proto, 'unbindStore', { writable: false })
}

const originalDescriptors = Object.getOwnPropertyDescriptors(proto)
const tracer = require('../../../../..')

assert.strictEqual(typeof tracer.init, 'function')
assert.deepStrictEqual(Object.getOwnPropertyDescriptors(proto), originalDescriptors)
