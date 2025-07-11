'use strict'

const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { breakThen, unbreakThen } = require('../../dd-trace/test/plugins/helpers')
const { expectedSchema, rawExpectedSchema } = require('./naming')

describe('Plugin', () => {
  let elasticsearch
  let tracer

  withVersions('elasticsearch', ['elasticsearch', '@elastic/elasticsearch'], (version, moduleName) => {
    const metaModule = require(`../../../versions/${moduleName}@${version}`)
    const hasCallbackSupport = !(moduleName === '@elastic/elasticsearch' && metaModule.version().split('.')[0] >= 8)

    describe('elasticsearch', () => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      describe('without configuration', () => {
        let client

        before(() => {
          return agent.load('elasticsearch')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          elasticsearch = metaModule.get()

          client = new elasticsearch.Client({
            node: 'http://localhost:9200'
          })
        })

        afterEach(() => {
          unbreakThen(Promise.prototype)
        })

        it('should sanitize the resource name', done => {
          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('resource', 'POST /logstash-?.?.?/_search')
            })
            .then(done)
            .catch(done)

          client.search({
            index: 'logstash-2000.01.01',
            body: {}
          }, hasCallbackSupport ? () => {} : undefined)
        })

        withPeerService(
          () => tracer,
          'elasticsearch',
          (done) => client.search({
            index: 'docs',
            sort: 'name',
            size: 100,
            body: {
              query: {
                match_all: {}
              }
            }
          // Ignore index_not_found_exception
          }, hasCallbackSupport ? () => done() : undefined)?.catch?.(() => {}),
          'localhost',
          'out.host'
        )

        it('should set the correct tags', done => {
          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
              expect(traces[0][0].meta).to.have.property('component', 'elasticsearch')
              expect(traces[0][0].meta).to.have.property('_dd.integration', 'elasticsearch')
              expect(traces[0][0].meta).to.have.property('db.type', 'elasticsearch')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('elasticsearch.method', 'POST')
              expect(traces[0][0].meta).to.have.property('elasticsearch.url', '/docs/_search')
              expect(traces[0][0].meta).to.have.property('out.host', 'localhost')

              if (hasCallbackSupport) {
                expect(traces[0][0].meta).to.have.property('elasticsearch.body', '{"query":{"match_all":{}}}')
                expect(traces[0][0].meta).to.have.property('elasticsearch.params', '{"sort":"name","size":100}')
              } else {
                expect(traces[0][0].meta).to.have.property(
                  'elasticsearch.body',
                  '{"query":{"match_all":{}},"sort":"name","size":100}'
                )
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
          }, hasCallbackSupport ? () => {} : undefined)
        })

        it('should set the correct tags on msearch', done => {
          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
              expect(traces[0][0].meta).to.have.property('component', 'elasticsearch')
              expect(traces[0][0].meta).to.have.property('db.type', 'elasticsearch')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('elasticsearch.method', 'POST')
              expect(traces[0][0].meta).to.have.property('elasticsearch.url', '/_msearch')
              expect(traces[0][0].meta).to.have.property(
                'elasticsearch.body',
                '[{"index":"docs"},{"query":{"match_all":{}}},{"index":"docs2"},{"query":{"match_all":{}}}]'
              )
            })
            .then(done)
            .catch(done)

          client.msearch({
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
          }, hasCallbackSupport ? () => {} : undefined)
        })

        it('should skip tags for unavailable fields', done => {
          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0].meta).to.not.have.property('elasticsearch.body')
            })
            .then(done)
            .catch(done)

          if (hasCallbackSupport) {
            client.ping(err => err && done(err))
          } else {
            client.ping().catch(done)
          }
        })

        if (hasCallbackSupport) {
          describe('when using a callback', () => {
            it('should do automatic instrumentation', done => {
              agent
                .assertSomeTraces(traces => {
                  expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
                  expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
                  expect(traces[0][0]).to.have.property('resource', 'HEAD /')
                  expect(traces[0][0]).to.have.property('type', 'elasticsearch')
                })
                .then(done)
                .catch(done)

              client.ping(err => err && done(err))
            })

            it('should propagate context', done => {
              agent
                .assertSomeTraces(traces => {
                  expect(traces[0][0]).to.have.property('parent_id')
                  expect(traces[0][0].parent_id).to.not.be.null
                })
                .then(done)
                .catch(done)

              const span = tracer.startSpan('test')

              tracer.scope().activate(span, () => {
                client.ping(() => span.finish())
              })
            })

            it('should run the callback in the parent context', done => {
              client.ping(error => {
                expect(tracer.scope().active()).to.be.null
                done(error)
              })
            })

            it('should handle errors', done => {
              let error

              agent
                .assertSomeTraces(traces => {
                  expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
                  expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
                  expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
                  expect(traces[0][0].meta).to.have.property('component', 'elasticsearch')
                })
                .then(done)
                .catch(done)

              client.search({ index: 'invalid' }, err => {
                error = err
              })
            })

            it('should support aborting the query', () => {
              expect(() => {
                client.ping(() => {}).abort()
              }).not.to.throw()
            })
          })
        }

        describe('when using a promise', () => {
          it('should do automatic instrumentation', done => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
                expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
                expect(traces[0][0]).to.have.property('resource', 'HEAD /')
                expect(traces[0][0]).to.have.property('type', 'elasticsearch')
              })
              .then(done)
              .catch(done)

            client.ping().catch(done)
          })

          it('should propagate context', done => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('parent_id')
                expect(traces[0][0].parent_id).to.not.be.null
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
              expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
              expect(traces[0][0].meta).to.have.property('component', 'elasticsearch')
            })
              .then(done)
              .catch(done)

            client.search({ index: 'invalid' })
              .catch(err => {
                error = err
              })
          })

          it('should support aborting the query', () => {
            expect(() => {
              const promise = client.ping()

              if (promise.abort) {
                promise.abort()
              }
            }).not.to.throw()
          })

          it('should work with userland promises', done => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('service', 'test-elasticsearch')
                expect(traces[0][0]).to.have.property('resource', 'HEAD /')
                expect(traces[0][0]).to.have.property('type', 'elasticsearch')
              })
              .then(done)
              .catch(done)

            breakThen(Promise.prototype)

            client.ping().catch(done)
          })

          describe('test', () => {
            withNamingSchema(
              () => {
                client.search(
                  { index: 'logstash-2000.01.01', body: {} },
                  hasCallbackSupport ? () => {} : undefined
                )
              },
              rawExpectedSchema.outbound
            )
          })
        })
      })

      describe('with configuration', () => {
        let client

        before(() => {
          return agent.load('elasticsearch', {
            service: 'custom',
            hooks: {
              query: (span, params) => {
                span.addTags({ 'elasticsearch.params': 'foo', 'elasticsearch.method': params.method })
              }
            }
          })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          elasticsearch = require(`../../../versions/${moduleName}@${version}`).get()
          client = new elasticsearch.Client({
            node: 'http://localhost:9200'
          })
        })

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
          }, hasCallbackSupport ? () => {} : undefined)

          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', 'custom')
              expect(traces[0][0].meta).to.have.property('component', 'elasticsearch')
              expect(traces[0][0].meta).to.have.property('elasticsearch.params', 'foo')
              expect(traces[0][0].meta).to.have.property('elasticsearch.method', 'POST')
            })
            .then(done)
            .catch(done)

          if (hasCallbackSupport) {
            client.ping(err => err && done(err))
          } else {
            client.ping().catch(done)
          }
        })

        withNamingSchema(
          () => {
            client.search(
              { index: 'logstash-2000.01.01', body: {} },
              hasCallbackSupport ? () => {} : undefined
            )
          },
          {
            v0: {
              opName: 'elasticsearch.query',
              serviceName: 'custom'
            },
            v1: {
              opName: 'elasticsearch.query',
              serviceName: 'custom'
            }
          }
        )
      })
    })
  })
})
