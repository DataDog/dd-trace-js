'use strict'

require('dd-trace/init')
const { inspect } = require('util')
const Fastify = require('fastify')

const fastify = Fastify({ logger: { level: 'error' } })

const weakObj = {}

fastify.get('/:name', function (request) {
  /* eslint-disable no-unused-vars */
  const nil = null
  const undef = undefined
  const bool = true
  const num = 42
  const bigint = 42n
  const str = 'foo'
  const lstr = '0123456789'.repeat(1000)
  const sym = Symbol('foo')
  const regex = /bar/i
  const emptyArr = []
  const arr = [{ a: 1 }, 2, 3, 4, 5]
  const emptyObj = {}
  const obj = {
    foo: {
      baz: 42,
      nil: null,
      undef: undefined,
      deep: { nested: { obj: { that: { goes: { on: { forever: true } } } } } }
    },
    bar: true,
    get baz () {
      return 'This is a getter!'
    },
    [inspect.custom] () {
      return 'This is a custom inspect!'
    }
  }
  const proxy = new Proxy(obj, {
    get () {
      return 'This is a proxy!'
    }
  })
  const circular = {}
  circular.circular = circular
  const ins = new CustomClass()
  const p = Promise.resolve(42)
  const arrowFn = () => {}
  const fn = function fn () {}
  const set = new Set([1, 2, 3, 4, 5])
  const map = new Map([[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]])
  const wset = new WeakSet([[weakObj]])
  const wmap = new WeakMap([[weakObj, 'foo']])
  const buf = Buffer.from('foobar')
  const err = new Error('foo')
  const abuf = new ArrayBuffer(10)
  for (let i = 0; i < 10; i++) {
    abuf[i] = i
  }
  const tarr = new Uint8Array(abuf)
  /* eslint-enable no-unused-vars */

  return { hello: request.params.name } // BREAKPOINT: /foo
})

fastify.listen({ port: process.env.APP_PORT || 0 }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  process.send?.({ port: fastify.server.address().port })
})

class CustomClass {
  #a = 1 // eslint-disable-line no-unused-private-class-members
  b = 2

  constructor () {
    this.c = 3
  }

  get [Symbol.toStringTag] () {
    return 'foo'
  }
}
