'use strict'

const axios = require('axios')
const { expect } = require('chai')
const { describe, it, beforeEach, afterEach, before, after } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { assertCodeOriginFromTraces } = require('../../datadog-code-origin/test/helpers')
const { getNextLineNumber } = require('../../dd-trace/test/plugins/helpers')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const host = 'localhost'

const modulePaths = [
  '../../dd-trace/src/plugins/util/stacktrace',
  '../../datadog-code-origin',
  '../src/index',
  '../src/code_origin'
].map(path => require.resolve(path))

function clearCodeOriginCaches () {
  for (const modulePath of modulePaths) {
    delete require.cache[modulePath]
  }
}

describe('Plugin', () => {
  let express, app, listener

  before(() => {
    process.env._DD_CODE_ORIGIN_ENABLE_FILTER = '1'
    clearCodeOriginCaches()
  })

  after(() => {
    delete process.env._DD_CODE_ORIGIN_ENABLE_FILTER
    clearCodeOriginCaches()
  })

  describe('express', () => {
    withVersions('express', 'express', (version) => {
      beforeEach(() => {
        express = require(`../../../versions/express@${version}`).get()
        app = express()
      })

      afterEach(() => listener?.close())

      describe('code origin for spans disabled', () => {
        const config = { codeOriginForSpans: { enabled: false } }

        describe(`with tracer config ${JSON.stringify(config)}`, () => {
          before(() => agent.load(['express', 'http', 'router'], [{}, { client: false }, {}], config))

          after(() => agent.close({ ritmReset: false, wipe: true }))

          it('should not add code_origin tag on entry spans', (done) => {
            app.get('/user', (req, res) => {
              res.end()
            })

            listener = app.listen(0, host, () => {
              Promise.all([
                agent.assertSomeTraces(traces => {
                  const spans = traces[0]
                  const tagNames = Object.keys(spans[0].meta)
                  expect(tagNames).to.all.not.match(/code_origin/)
                }),
                axios.get(`http://localhost:${listener.address().port}/user`)
              ]).then(() => done(), done)
            })
          })
        })
      })

      describe('code origin for spans enabled', () => {
        const configs = [{}, { codeOriginForSpans: { enabled: true } }]

        for (const config of configs) {
          describe(`with tracer config ${JSON.stringify(config)}`, () => {
            before(() => agent.load(['express', 'http', 'router'], [{}, { client: false }, {}], config))

            after(() => agent.close({ ritmReset: false, wipe: true }))

            it('should add code_origin tag on entry spans when feature is enabled', async function testCase () {
              let line

              // Wrap in a function to have a frame without a function or type name
              (() => {
                app.get('/route_before', (req, res) => res.end())
                line = getNextLineNumber()
                app.get('/user', (req, res) => {
                  res.end()
                })
                app.get('/route_after', (req, res) => res.end())
              })()

              await assertCodeOrigin('/user', { line })
            })

            it('should point to where actual route handler is configured, not the router', async function testCase () {
              const router = express.Router()

              router.get('/route_before', (req, res) => res.end())
              const line = getNextLineNumber()
              router.get('/user', (req, res) => {
                res.end()
              })
              router.get('/route_after', (req, res) => res.end())
              app.get('/route_before', (req, res) => res.end())
              app.use('/v1', router)
              app.get('/route_after', (req, res) => res.end())

              await assertCodeOrigin('/v1/user', { line, method: 'testCase', type: 'Context' })
            })

            it('should support .use() routes', async function testCase () {
              app.get('/route_before', (req, res) => res.end())
              const line = getNextLineNumber()
              app.use('/foo', (req, res) => {
                res.end()
              })
              app.get('/route_after', (req, res) => res.end())

              await assertCodeOrigin('/foo/bar', { line, method: 'testCase', type: 'Context' })
            })

            it('should support .route() routes', async function testCase () {
              app.get('/route_before', (req, res) => res.end())
              const route = app.route('/foo')
              const line = getNextLineNumber()
              route.get((req, res) => {
                res.end()
              })
              app.get('/route_after', (req, res) => res.end())
              await assertCodeOrigin('/foo', { line, method: 'testCase', type: 'Context' })
            })

            it('should support Router routes', async function testCase () {
              const router = express.Router()
              app.get('/route_before', (req, res) => res.end())
              const line = getNextLineNumber()
              router.get('/bar', (req, res) => {
                res.end()
              })
              app.use('/foo', router)
              app.get('/route_after', (req, res) => res.end())
              await assertCodeOrigin('/foo/bar', { line, method: 'testCase', type: 'Context' })
            })

            it('should point to route handler even if passed through a middleware', async function testCase () {
              app.use((req, res, next) => {
                next()
              })
              const line = getNextLineNumber()
              app.get('/user', (req, res) => {
                res.end()
              })

              await assertCodeOrigin('/user', { line, method: 'testCase', type: 'Context' })
            })

            it('should point to middleware if middleware responds early', async function testCase () {
              const line = getNextLineNumber()
              app.use((req, res, next) => {
                res.end()
              })
              app.get('/user', (req, res) => {
                res.end()
              })

              await assertCodeOrigin('/user', { line, method: 'testCase', type: 'Context' })
            })
          })
        }
      })
    })
  })

  function assertCodeOrigin (path, frame) {
    return new Promise((resolve, reject) => {
      listener = app.listen(0, host, async () => {
        try {
          await Promise.all([
            agent.assertSomeTraces((traces) => {
              assertCodeOriginFromTraces(traces, { file: __filename, ...frame })
            }),
            axios.get(`http://localhost:${listener.address().port}${path}`)
          ])
        } catch (err) {
          reject(err)
        }

        resolve()
      })
    })
  }
})
