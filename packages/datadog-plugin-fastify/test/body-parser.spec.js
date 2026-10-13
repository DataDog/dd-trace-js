'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')

const agent = require('../../dd-trace/test/plugins/agent')
const httpRequest = require('../../dd-trace/test/setup/helpers/http-client')
const { withExports, withVersions } = require('../../dd-trace/test/setup/mocha')

const bodyParserReadCh = dc.channel('datadog:fastify:body-parser:finish')

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
            app = fastify()

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
            const body = '"' + 'A'.repeat(32 * 1024 * 1024) + '"'

            const res = await httpRequest.post(url, body, { headers: { 'content-type': 'application/json' } })

            assert.strictEqual(res.status, 200)
            assert.strictEqual(res.data, 'DONE')
            assert.deepStrictEqual(bodies, [body])
          })

          it('publishes a binary body once without enumerating its bytes', async () => {
            const body = Buffer.alloc(32 * 1024 * 1024)

            const res = await httpRequest.post(url, body, { headers: { 'content-type': 'application/octet-stream' } })

            assert.strictEqual(res.status, 200)
            assert.strictEqual(bodies.length, 1)
            assert.ok(Buffer.isBuffer(bodies[0]))
            assert.strictEqual(bodies[0].length, body.length)
          })

          it('does not publish an empty body', async () => {
            const res = await httpRequest.post(url, '', { headers: { 'content-type': 'application/json' } })

            assert.strictEqual(res.status, 200)
            assert.deepStrictEqual(bodies, [])
          })
        })
      })
    })
  })
})
