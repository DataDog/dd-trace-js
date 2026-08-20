'use strict'

// @ts-expect-error This code is running in a sandbox where dd-trace is available
require('dd-trace/init')
const { inspect } = require('util')
// @ts-expect-error This code is running in a sandbox where fastify is available
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
  const maxObj = { a: 1, b: 2, c: 3, d: 4, e: 5 }
  Object.defineProperty(maxObj, 'hidden', { value: 6 })
  const obj = {
    foo: {
      baz: 42,
      nil: null,
      undef: undefined,
      deep: { nested: { obj: { that: { goes: { on: { forever: true } } } } } },
    },
    bar: true,
    get baz () {
      return 'This is a getter!'
    },
    qux: 42,
    quux: false,
    [inspect.custom] () {
      return 'This is a custom inspect!'
    },
  }
  const proxy = new Proxy(obj, {
    get () {
      return 'This is a proxy!'
    },
  })
  const objectWithProxyPrototype = Object.create(new Proxy({}, {
    getPrototypeOf () {
      throw new Error('Proxy prototype trap should not run')
    },
  }))
  Object.defineProperties(objectWithProxyPrototype, {
    a: { value: 1, enumerable: true },
    b: { value: 2, enumerable: true },
    c: { value: 3, enumerable: true },
    d: { value: 4, enumerable: true },
    e: { value: 5, enumerable: true },
    f: { value: 6, enumerable: true },
  })
  const sideEffectfulObject = {
    a: 1,
    b: 2,
    get [Symbol.toStringTag] () {
      throw new Error('Symbol.toStringTag getter should not run')
    },
    [Symbol('extra')]: 4,
  }
  const circular = {}
  circular.circular = circular
  const wideCircular = { circular: undefined, a: 1, b: 2, c: 3, d: 4, e: 5 }
  wideCircular.circular = wideCircular
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
    this.d = 4
    this.e = 5
    this.f = 6
    this.g = 7
  }

  get [Symbol.toStringTag] () {
    return 'foo'
  }
}
