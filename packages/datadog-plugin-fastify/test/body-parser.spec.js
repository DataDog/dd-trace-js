'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')

const agent = require('../../dd-trace/test/plugins/agent')
const httpRequest = require('../../dd-trace/test/setup/helpers/http-client')
const { withExports, withVersions } = require('../../dd-trace/test/setup/mocha')

const bodyParserReadCh = dc.channel('datadog:fastify:body-parser:finish')
const BODY_SIZE_BYTES = 32 * 1024 * 1024

describe('Plugin', () => {
  describe('fastify', () => {
    withVersions('fastify', 'fastify', version => {
      withExports('fastify', version, ['default', 'fastify'], '>=3', getExport => {
        describe('request body publishing', () => {
          let app
          let url
          let bodies

          function onBody ({ body }) {
            bodies.push(body)
          }

          before(() => agent.load(['fastify', 'find-my-way', 'http'], [{}, {}, { client: false }]))

          after(() => agent.close())

          beforeEach(async () => {
            bodies = []
            bodyParserReadCh.subscribe(onBody)

            const fastify = getExport()
            app = fastify({ bodyLimit: BODY_SIZE_BYTES * 2 })

            if (semver.intersects(version, '>=3')) {
              await app.register(require('../../../versions/middie').get())
            }

            // Leaves JSON bodies as raw strings, like the tRPC adapter does.
            const passThrough = (request, body, done) => done(null, body)
            app.addContentTypeParser('application/json', { parseAs: 'string' }, passThrough)
            app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, passThrough)
            app.post('/', (request, reply) => reply.send('DONE'))

            await app.listen({ host: '127.0.0.1', port: 0 })
            url = `http://127.0.0.1:${app.server.address().port}/`
          })

          afterEach(async () => {
            bodyParserReadCh.unsubscribe(onBody)
            await app.close()
          })

          it('publishes a string body once without enumerating its characters', async () => {
            const body = '"' + 'A'.repeat(BODY_SIZE_BYTES) + '"'

            const res = await httpRequest.post(url, body, { headers: { 'content-type': 'application/json' } })

            assert.strictEqual(res.status, 200)
            assert.strictEqual(res.data, 'DONE')
            assert.deepStrictEqual(bodies, [body])
          })

          it('publishes a binary body once without enumerating its bytes', async () => {
            const body = Buffer.alloc(BODY_SIZE_BYTES)

            const res = await httpRequest.post(url, body, { headers: { 'content-type': 'application/octet-stream' } })

            assert.strictEqual(res.status, 200)
            assert.strictEqual(bodies.length, 1)
            assert.ok(Buffer.isBuffer(bodies[0]))
            assert.strictEqual(bodies[0].length, body.length)
          })

          // Mirrors multipart parsers: the body only exists after the instrumentation's `preValidation` ran, so
          // it is published from `preHandler`. Fastify 1 has no `preValidation` hook to set it from.
          const describeLateBody = semver.intersects(version, '>=2') ? describe : describe.skip

          describeLateBody('when the body is set after preValidation', () => {
            let lateBody

            beforeEach(async () => {
              await app.close()

              const fastify = getExport()
              app = fastify({ bodyLimit: BODY_SIZE_BYTES * 2 })

              if (semver.intersects(version, '>=3')) {
                await app.register(require('../../../versions/middie').get())
              }

              app.addHook('preValidation', (request, reply, done) => {
                request.body = lateBody
                done()
              })
              app.post('/', (request, reply) => reply.send('DONE'))

              await app.listen({ host: '127.0.0.1', port: 0 })
              url = `http://127.0.0.1:${app.server.address().port}/`
            })

            const publishedBodies = {
              'an object': () => ({ a: 1 }),
              'an array': () => [1],
              'a large string': () => 'A'.repeat(BODY_SIZE_BYTES),
              'a large Buffer': () => Buffer.alloc(BODY_SIZE_BYTES),
              'a large Uint8Array': () => new Uint8Array(BODY_SIZE_BYTES),
              'a large array': () => new Array(BODY_SIZE_BYTES),
            }

            for (const [name, createBody] of Object.entries(publishedBodies)) {
              it(`publishes ${name} body once without enumerating its elements`, async () => {
                lateBody = createBody()

                const res = await httpRequest.post(url)

                assert.strictEqual(res.status, 200)
                assert.strictEqual(bodies.length, 1)
                assert.strictEqual(bodies[0], lateBody)
              })
            }

            const unpublishedBodies = {
              'an empty string': '',
              'an empty object': {},
              'an empty array': [],
              'an empty Buffer': Buffer.alloc(0),
              'an empty Uint8Array': new Uint8Array(0),
              'a null': null,
              'a number': 1,
              'a boolean': true,
            }

            for (const [name, body] of Object.entries(unpublishedBodies)) {
              it(`does not publish ${name} body`, async () => {
                lateBody = body

                const res = await httpRequest.post(url)

                assert.strictEqual(res.status, 200)
                assert.deepStrictEqual(bodies, [])
              })
            }
          })

          it('does not publish an empty body', async () => {
            const res = await httpRequest.post(url)

            assert.strictEqual(res.status, 200)
            assert.deepStrictEqual(bodies, [])
          })
        })
      })
    })
  })
})
