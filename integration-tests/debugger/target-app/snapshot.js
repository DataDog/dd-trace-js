'use strict'

require('dd-trace/init')
const Fastify = require('fastify')

const fastify = Fastify({ logger: { level: 'error' } })

fastify.get('/:name', function handler (request) {
  /* eslint-disable no-unused-vars */
  const nil = null
  const undef = getUndefined()
  const bool = true
  const num = 42
  const bigint = 42n
  const str = 'foo'
  // eslint-disable-next-line @stylistic/max-len
  const lstr = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.'
  const sym = Symbol('foo')
  const regex = /bar/i
  const arr = [1, 2, 3, 4, 5]
  const obj = {
    foo: {
      baz: 42,
      nil: null,
      undef: undefined,
      deep: { nested: { obj: { that: { goes: { on: { forever: true } } } } } }
    },
    bar: true
  }
  const emptyObj = {}
  const p = Promise.resolve()
  const arrowFn = () => {}
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

function getUndefined () {}
