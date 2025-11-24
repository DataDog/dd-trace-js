'use strict'

const assert = require('node:assert/strict')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { breakThen, unbreakThen } = require('../../dd-trace/test/plugins/helpers')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema, rawExpectedSchema } = require('./naming')
describe('Plugin', () => {
  let opensearch
  let tracer

  withVersions('opensearch', ['opensearch', '@opensearch-project/opensearch'], (version, moduleName) => {
    const metaModule = require(`../../../versions/${moduleName}@${version}`)

    describe('opensearch', () => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      describe('without configuration', () => {
        let client

        before(() => {
          return agent.load('opensearch')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          opensearch = metaModule.get()

          client = new opensearch.Client({
            node: 'http://127.0.0.1:9201'
          })
        })

        afterEach(() => {
          unbreakThen(Promise.prototype)
        })

        it('should sanitize the resource name', done => {
          agent
            .assertFirstTraceSpan({
              resource: 'POST /logstash-?.?.?/_search'
            })
            .then(done)
            .catch(done)

          client.search({
            index: 'logstash-2000.01.01',
            body: {}
          })
        })

        it('should set the correct tags', done => {
          agent
            .assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              meta: {
                'db.type': 'opensearch',
                'span.kind': 'client',
                'opensearch.method': 'POST',
                'opensearch.url': '/docs/_search',
                'opensearch.body': '{"query":{"match_all":{}}}',
                component: 'opensearch',
                'out.host': '127.0.0.1'
              }
            })
            .then(done)
            .catch(done)

          client.search({
            index: 'docs',
            sort: 'name',
            size: 100,
            body: {
              query: {
                match_all: {}
              }
            }
          })
        })

        it('should set the correct tags on msearch', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
              assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
              assert.strictEqual(traces[0][0].meta['db.type'], 'opensearch')
              assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
              assert.strictEqual(traces[0][0].meta['opensearch.method'], 'POST')
              assert.strictEqual(traces[0][0].meta['opensearch.url'], '/_msearch')
              assert.ok('opensearch.body' in traces[0][0].meta)
              assert.strictEqual(traces[0][0].meta['opensearch.body'], '[{"index":"docs"},{"query":{"match_all":{}}},{"index":"docs2"},{"query":{"match_all":{}}}]')
              assert.strictEqual(traces[0][0].meta['opensearch.params'], '{"size":100}')
              assert.strictEqual(traces[0][0].meta.component, 'opensearch')
              assert.strictEqual(traces[0][0].meta['_dd.integration'], 'opensearch')
            })
            .then(done)
            .catch(done)

          client.msearch({
            size: 100,
            body: [
              { index: 'docs' },
              {
                query: {
                  match_all: {}
                }
              },
              { index: 'docs2' },
              {
                query: {
                  match_all: {}
                }
              }
            ]
          })
        })

        it('should skip tags for unavailable fields', done => {
          agent
            .assertSomeTraces(traces => {
              assert.ok(!Object.hasOwn(traces[0][0].meta, 'opensearch.body'))
            })
            .then(done)
            .catch(done)

          client.ping().catch(done)
        })

        it('should do automatic instrumentation', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
              assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
              assert.strictEqual(traces[0][0].resource, 'HEAD /')
              assert.strictEqual(traces[0][0].type, 'elasticsearch')
              assert.strictEqual(traces[0][0].meta.component, 'opensearch')
            })
            .then(done)
            .catch(done)

          client.ping().catch(done)
        })

        it('should propagate context', done => {
          agent
            .assertSomeTraces(traces => {
              assert.ok(Object.hasOwn(traces[0][0], 'parent_id'))
              assert.notStrictEqual(traces[0][0].parent_id, null)
            })
            .then(done)
            .catch(done)

          const span = tracer.startSpan('test')

          tracer.scope().activate(span, () => {
            client.ping()
              .then(() => span.finish())
              .catch(done)
          })
        })

        it('should handle errors', done => {
          let error

          agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].meta[ERROR_TYPE], error.name)
            assert.strictEqual(traces[0][0].meta[ERROR_MESSAGE], error.message)
            assert.strictEqual(traces[0][0].meta[ERROR_STACK], error.stack)
            assert.strictEqual(traces[0][0].meta.component, 'opensearch')
          })
            .then(done)
            .catch(done)

          client.search({ index: 'invalid' })
            .catch(err => {
              error = err
            })
        })

        it('should support aborting the query', () => {
          assert.doesNotThrow(() => {
            const promise = client.ping()

            if (promise.abort) {
              promise.abort()
            }
          })
        })

        it('should work with userland promises', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
              assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
              assert.strictEqual(traces[0][0].resource, 'HEAD /')
              assert.strictEqual(traces[0][0].type, 'elasticsearch')
            })
            .then(done)
            .catch(done)

          breakThen(Promise.prototype)

          client.ping().catch(done)
        })

        withNamingSchema(
          () => {
            client.search({ index: 'logstash-2000.01.01', body: {} })
          },
          rawExpectedSchema.outbound
        )
      })

      describe('with configuration', () => {
        let client

        before(() => {
          return agent.load('opensearch', {
            service: 'custom',
            hooks: {
              query: (span, params) => {
                span.addTags({ 'opensearch.params': 'foo', 'opensearch.method': params.method })
              }
            }
          })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          opensearch = require(`../../../versions/${moduleName}@${version}`).get()
          client = new opensearch.Client({
            node: 'http://127.0.0.1:9201'
          })
        })

        withPeerService(
          () => tracer,
          'opensearch',
          () => client.search({
            index: 'docs',
            sort: 'name',
            size: 100,
            body: {
              query: {
                match_all: {}
              }
            }
          }).catch(() => {
            // Ignore index_not_found_exception for peer service assertion
          }),
          '127.0.0.1',
          'out.host'
        )

        it('should be configured with the correct values', done => {
          client.search({
            index: 'docs',
            sort: 'name',
            size: 100,
            body: {
              query: {
                match_all: {}
              }
            }
          })

          agent
            .assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: 'custom',
              meta: {
                'opensearch.params': 'foo',
                'opensearch.method': 'POST',
                component: 'opensearch'
              }
            })
            .then(done)
            .catch(done)

          client.ping().catch(done)
        })

        withNamingSchema(
          () => {
            client.search({ index: 'logstash-2000.01.01', body: {} })
          },
          {
            v0: {
              opName: 'opensearch.query',
              serviceName: 'custom'
            },
            v1: {
              opName: 'opensearch.query',
              serviceName: 'custom'
            }
          }
        )
      })
    })
  })
})
