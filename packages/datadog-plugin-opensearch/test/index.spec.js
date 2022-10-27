'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { breakThen, unbreakThen } = require('../../dd-trace/test/plugins/helpers')

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
            node: 'http://localhost:9201'
          })
        })

        afterEach(() => {
          unbreakThen(Promise.prototype)
        })

        it('should sanitize the resource name', done => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('resource', 'POST /logstash-?.?.?/_search')
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
            .use(traces => {
              expect(traces[0][0].meta).to.have.property('db.type', 'opensearch')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('opensearch.method', 'POST')
              expect(traces[0][0].meta).to.have.property('opensearch.url', '/docs/_search')
              expect(traces[0][0].meta).to.have.property(
                'opensearch.body',
                '{"query":{"match_all":{}}}'
              )
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
            .use(traces => {
              expect(traces[0][0].meta).to.have.property('db.type', 'opensearch')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('opensearch.method', 'POST')
              expect(traces[0][0].meta).to.have.property('opensearch.url', '/_msearch')
              expect(traces[0][0].meta).to.have.property(
                'opensearch.body',
                '[{"index":"docs"},{"query":{"match_all":{}}},{"index":"docs2"},{"query":{"match_all":{}}}]'
              )
              expect(traces[0][0].meta).to.have.property('opensearch.params', '{"size":100}')
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
            .use(traces => {
              expect(traces[0][0].meta).to.not.have.property('opensearch.body')
            })
            .then(done)
            .catch(done)

          client.ping().catch(done)
        })

        it('should do automatic instrumentation', done => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', 'test-opensearch')
              expect(traces[0][0]).to.have.property('resource', 'HEAD /')
              expect(traces[0][0]).to.have.property('type', 'elasticsearch')
            })
            .then(done)
            .catch(done)

          client.ping().catch(done)
        })

        it('should propagate context', done => {
          agent
            .use(traces => {
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

          agent.use(traces => {
            expect(traces[0][0].meta).to.have.property('error.type', error.name)
            expect(traces[0][0].meta).to.have.property('error.msg', error.message)
            expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
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
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', 'test-opensearch')
              expect(traces[0][0]).to.have.property('resource', 'HEAD /')
              expect(traces[0][0]).to.have.property('type', 'elasticsearch')
            })
            .then(done)
            .catch(done)

          breakThen(Promise.prototype)

          client.ping().catch(done)
        })
      })

      describe('with configuration', () => {
        let client

        before(() => {
          return agent.load('opensearch', {
            service: 'test',
            hooks: { query: (span, params) => {
              span.addTags({ 'opensearch.params': 'foo', 'opensearch.method': params.method })
            } }
          })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          opensearch = require(`../../../versions/${moduleName}@${version}`).get()
          client = new opensearch.Client({
            node: 'http://localhost:9201'
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
          })

          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', 'test')
              expect(traces[0][0].meta).to.have.property('opensearch.params', 'foo')
              expect(traces[0][0].meta).to.have.property('opensearch.method', 'POST')
            })
            .then(done)
            .catch(done)

          client.ping().catch(done)
        })
      })
    })
  })
})
