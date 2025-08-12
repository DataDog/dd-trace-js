'use strict'

const axios = require('axios')
const semver = require('semver')
const { withExports, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { assertCodeOriginFromTraces } = require('../../datadog-code-origin/test/helpers')
const { getNextLineNumber } = require('../../dd-trace/test/plugins/helpers')
const { NODE_MAJOR } = require('../../../version')

describe('Plugin', () => {
  let fastify, app

  describe('fastify', () => {
    withVersions('fastify', 'fastify', (version, _, specificVersion) => {
      if (NODE_MAJOR <= 18 && semver.satisfies(specificVersion, '>=5')) return

      afterEach(() => app.close())

      withExports('fastify', version, ['default', 'fastify'], '>=3', getExport => {
        beforeEach(async () => {
          fastify = getExport()
          app = fastify()

          if (semver.intersects(version, '>=3')) {
            await app.register(require('../../../versions/middie').get())
          }
        })

        describe('code origin for spans disabled', () => {
          const config = { codeOriginForSpans: { enabled: false } }

          describe(`with tracer config ${JSON.stringify(config)}`, () => {
            before(() => agent.load(['fastify', 'find-my-way', 'http'], [{}, {}, { client: false }], config))

            after(() => agent.close({ ritmReset: false, wipe: true }))

            it('should not add code_origin tag on entry spans', async () => {
              app.get('/user', function (request, reply) {
                reply.send()
              })

              await app.listen(getListenOptions())

              await Promise.all([
                agent.assertSomeTraces(traces => {
                  const spans = traces[0]
                  const tagNames = Object.keys(spans[0].meta)
                  expect(tagNames).to.all.not.match(/code_origin/)
                }),
                axios.get(`http://localhost:${app.server.address().port}/user`)
              ])
            })
          })
        })

        describe('code origin for spans enabled', () => {
          if (semver.satisfies(specificVersion, '<4')) return // TODO: Why doesn't it work on older versions?

          const configs = [{}, { codeOriginForSpans: { enabled: true } }]

          for (const config of configs) {
            describe(`with tracer config ${JSON.stringify(config)}`, () => {
              before(() => agent.load(['fastify', 'find-my-way', 'http'], [{}, {}, { client: false }], config))

              after(() => agent.close({ ritmReset: false, wipe: true }))

              it('should add code_origin tag on entry spans when feature is enabled', async function testCase () {
                let line

                // Wrap in a function to have a frame without a function or type name
                (() => {
                  line = getNextLineNumber()
                  app.get('/user', (request, reply) => {
                    reply.send()
                  })
                })()

                await assertCodeOrigin('/user', { line })
              })

              it('should point to where actual route handler is configured, not the prefix', async () => {
                let line

                app.register(function v1Handler (app, opts, done) {
                  line = getNextLineNumber()
                  app.get('/user', (request, reply) => {
                    reply.send()
                  })
                  done()
                }, { prefix: '/v1' })

                await app.ready()

                await assertCodeOrigin('/v1/user', { line, method: 'v1Handler' })
              })

              it('should point to route handler even if passed through a middleware', async function testCase () {
                app.use((req, res, next) => {
                  next()
                })
                const line = getNextLineNumber()
                app.get('/user', (request, reply) => {
                  reply.send()
                })

                await assertCodeOrigin('/user', { line, method: 'testCase', type: 'Context' })
              })

              // TODO: In Fastify, the route is resolved before the middleware is called, so we actually can get the
              // line number of where the route handler is defined. However, this might not be the right choice and it
              // might be better to point to the middleware.
              it.skip('should point to middleware if middleware responds early', async function testCase () {
                const line = getNextLineNumber()
                app.use((req, res, next) => {
                  res.end()
                })
                app.get('/user', (request, reply) => {
                  reply.send()
                })

                await assertCodeOrigin('/user', { line, method: 'testCase', type: 'Context' })
              })
            })
          }
        })
      })
    })
  })

  async function assertCodeOrigin (path, frame) {
    await app.listen(getListenOptions())
    await Promise.all([
      agent.assertSomeTraces(traces => {
        assertCodeOriginFromTraces(traces, { file: __filename, ...frame })
      }),
      axios.get(`http://localhost:${app.server.address().port}${path}`)
    ])
  }
})

// Required by Fastify 1.0.0
function getListenOptions () {
  return { host: 'localhost', port: 0 }
}
