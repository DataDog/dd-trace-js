'use strict'

// @ts-expect-error This code is running in a sandbox where dd-trace is available
require('dd-trace/init')
// @ts-expect-error This code is running in a sandbox where fastify is available
const Fastify = require('fastify')

const fastify = Fastify({ logger: { level: 'error' } })

fastify.get('/', function () {
  /* eslint-disable no-unused-vars, sonarjs/no-unused-collection */
  const foo = 'a'
  const bar = 'b'
  const baz = 'c'
  const secret = 'shh!'
  const password = 'shh!'
  const secretSymbol = Symbol('password')
  const obj = { username: 'alice', password: 'shh!', [secretSymbol]: 'shh!' }
  const map = new Map([['username', 'alice'], ['password', 'shh!'], [secretSymbol, 'shh!']])
  const vmMap = require('node:vm').runInNewContext("new Map([['password', 'shh!']])")
  const proxy = new Proxy({ password: 'shh!' }, {})
  const bigMap = new Map([['k0', 0], ['k1', 1], ['k2', 2], ['k3', 3], ['password', 'shh!']])
  const mapWithProp = new Map([['username', 'alice']])
  mapWithProp.password = 'shh!'
  const fnWithSecret = function handler () {}
  fnWithSecret.password = 'shh!'
  fnWithSecret.username = 'alice'
  class MapWithCustomKeys extends Map { keys () { throw new Error('keys() must not be called during redaction') } }
  const mapWithOverriddenKeys = new MapWithCustomKeys([['password', 'shh!']])
  const fnProxy = new Proxy(fnWithSecret, {})
  /* eslint-enable no-unused-vars, sonarjs/no-unused-collection */

  return { hello: 'world' } // BREAKPOINT: /
})

fastify.get('/shadow', function () {
  // Shadow the intrinsics the redaction setup relies on. If the setup resolved them from the
  // paused call frame instead of the global object, `new Set(...)` would throw and every log
  // probe at this pause would be sent with an empty message.
  /* eslint-disable no-unused-vars, sonarjs/no-globals-shadowing */
  const Set = 'shadow'
  const Map = 'shadow'
  const Object = 'shadow'
  const Reflect = 'shadow'
  const shadowObj = { username: 'alice', password: 'shh!' }
  /* eslint-enable no-unused-vars, sonarjs/no-globals-shadowing */

  return { hello: 'world' } // BREAKPOINT: /shadow
})

fastify.listen({ port: process.env.APP_PORT || 0 }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  process.send?.({ port: fastify.server.address().port })
})
