'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { after, afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const semver = require('semver')
const sinon = require('sinon')

const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { expectedSchema, rawExpectedSchema } = require('./naming')

describe('Plugin', () => {
  let couchbase

  describe('couchbase', () => {
    let cluster
    let bucket
    let tracer
    let collection

    /**
     * @param {string} versionKey
     * @param {string} _moduleName
     * @param {string} resolvedVersion
     */
    function registerVersionTests (versionKey, _moduleName, resolvedVersion) {
      describe('without configuration', () => {
        beforeEach(async function () {
          this.timeout(10_000)
          tracer = global.tracer = await agent.load('couchbase', { enabled: false })
          couchbase = proxyquire(`../../../versions/couchbase@${versionKey}`, {}).get()
          cluster = await couchbase.connect('couchbase://localhost', {
            username: 'Administrator',
            password: 'password',
          })
          bucket = cluster.bucket('datadog-test')
          collection = bucket.defaultCollection()
          if (semver.gte(resolvedVersion, '4.0.0')) {
            await waitForCollectionConnection(collection, couchbase)
          }
          agent.reload('couchbase', { enabled: true })
        })

        afterEach(async () => {
          await cluster.close()
        })

        after(() => {
          return agent.close()
        })

        withNamingSchema(
          done => cluster.query('SELECT 1+1').catch(done),
          rawExpectedSchema.query
        )

        it('should run the Query callback in the parent context', done => {
          const query = 'SELECT 1+1'
          const span = tracer.startSpan('test.query.cb')

          tracer.scope().activate(span, () => {
            cluster.query(query).then(rows => {
              assert.strictEqual(tracer.scope().active(), span)
            }).then(done)
              .catch(done)
          })
        })

        it('should run any Collection operations in the parent context', done => {
          const span = tracer.startSpan('test')
          tracer.scope().activate(span, () => {
            collection.exists('1').then(() => {
              assert.strictEqual(tracer.scope().active(), span)
            }).then(done).catch(done)
          })
        })

        describe('queries on Cluster', () => {
          it('should handle N1QL queries', done => {
            const query = 'SELECT 1+1'

            agent
              .assertFirstTraceSpan({
                name: expectedSchema.query.opName,
                service: expectedSchema.query.serviceName,
                resource: query,
                type: 'sql',
                meta: {
                  'span.kind': 'client',
                  component: 'couchbase',
                },
              })
              .then(done)
              .catch(done)

            cluster.query(query).catch(done)
          })

          it('should handle storage queries', done => {
            agent
              .assertFirstTraceSpan({
                name: expectedSchema.upsert.opName,
                service: expectedSchema.upsert.serviceName,
                resource: 'couchbase.upsert',
                meta: {
                  'span.kind': 'client',
                  'couchbase.bucket.name': 'datadog-test',
                  'couchbase.collection.name': '_default',
                  component: 'couchbase',
                },
              })
              .then(done)
              .catch(done)

            collection.upsert('testdoc', { name: 'Frank' }).catch(err => done(err))
          })

          it('should skip instrumentation for invalid arguments', (done) => {
            const checkError = (e) => {
              const expectedMessages = [
                // depending on version of node
                'Cannot read property \'toString\' of undefined',
                'Cannot read properties of undefined (reading \'toString\')',
                'parsing failure', // sdk 4
              ]
              assert.ok(
                expectedMessages.includes(e.message),
                `Expected error message in ${inspect(expectedMessages)}, got ${inspect(e.message)}`
              )
              done()
            }
            try {
              cluster.query(undefined).catch(checkError) // catch bad errors
            } catch (e) {
              // catch errors conventionally as well
              checkError(e)
            }
          })
        })

        describe('operations still work with callbacks', () => {
          it('should perform normal cluster query operation with callback', done => {
            const query = 'SELECT 1+1'
            agent
              .assertFirstTraceSpan({
                name: expectedSchema.query.opName,
                service: expectedSchema.query.serviceName,
                resource: query,
                type: 'sql',
                meta: {
                  'span.kind': 'client',
                  component: 'couchbase',
                },
              })
              .then(done)
              .catch(done)

            cluster.query(query, (err, rows) => {
              if (err) done(err)
            })
          })

          describe('errors are handled correctly in callbacks', () => {
            it('should catch error in callback for non-traced functions', done => {
              const invalidIndex = '-1'
              collection.get(invalidIndex, (err) => { if (err) done() })
            })

            // due to bug in couchbase for these versions (see JSCBC-945)
            if (!semver.satisfies(resolvedVersion, '3.2.0 - 3.2.1')) {
              it('should catch errors in callback and report error in trace', done => {
                const invalidQuery = 'SELECT'
                const cb = sinon.spy()
                agent
                  .assertSomeTraces(traces => {
                    const span = traces[0][0]
                    sinon.assert.calledOnce(cb)
                    // different couchbase sdk versions will have different error messages/types
                    assert.strictEqual(span.error, 1)
                  }).then(done).catch(done)
                cluster.query(invalidQuery, cb)
              })
            }
          })
        })
      })
    }

    withVersions('couchbase', 'couchbase', '>=3.0.0', registerVersionTests)
  })
})

/**
 * Couchbase 4.x resolves connect before its collection KV connection is usable.
 *
 * @param {{
 *   exists(key: string): Promise<unknown>
 * }} collection
 * @param {{ TimeoutError: typeof Error }} couchbase
 */
async function waitForCollectionConnection (collection, couchbase) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await collection.exists('dd-trace-readiness')
      return
    } catch (error) {
      if (!(error instanceof couchbase.TimeoutError) || attempt === 2) throw error
    }
  }
}
