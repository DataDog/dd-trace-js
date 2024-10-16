'use strict'

require('dd-trace/init')
const Fastify = require('fastify')

const fastify = Fastify()

// Since line probes have hardcoded line numbers, we want to try and keep the line numbers from changing within the
// `handler` function below when making changes to this file. This is achieved by calling `getSomeData` and keeping all
// variable names on the same line as much as possible.
fastify.get('/:name', function handler (request) {
  // eslint-disable-next-line no-unused-vars
  const { nil, undef, bool, num, bigint, str, lstr, sym, regex, arr, obj, emptyObj, fn, p } = getSomeData()
  return { hello: request.params.name }
})

// WARNING: Breakpoints present above this line - Any changes to the lines above might influence tests!

fastify.listen({ port: process.env.APP_PORT }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  process.send({ port: process.env.APP_PORT })
})

function getSomeData () {
  return {
    nil: null,
    undef: undefined,
    bool: true,
    num: 42,
    bigint: 42n,
    str: 'foo',
    // eslint-disable-next-line @stylistic/js/max-len
    lstr: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
    sym: Symbol('foo'),
    regex: /bar/i,
    arr: [1, 2, 3],
    obj: {
      foo: {
        baz: 42,
        nil: null,
        undef: undefined,
        deep: { nested: { obj: { that: { goes: { on: { forever: true } } } } } }
      },
      bar: true
    },
    emptyObj: {},
    fn: () => {},
    p: Promise.resolve()
  }
}
