'use strict'

const agent = require('../../dd-trace/test/plugins/agent')

// Retries and the initial request result in a trace with multiple spans.
// The last span is the one that actually did the query.
const last = spans => spans[spans.length - 1]

describe('Plugin', () => {
  let elasticsearch
  let tracer

  withVersions('elasticsearch', ['elasticsearch', '@elastic/elasticsearch'], (version, moduleName) => {
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
          elasticsearch = require(`../../../versions/${moduleName}@${version}`).get()
          client = new elasticsearch.Client({
            node: 'http://localhost:9200'
          })
        })

        it('should sanitize the resource name', done => {
          agent
            .use(traces => {
              expect(last(traces[0])).to.have.property('resource', 'POST /logstash-?.?.?/_search')
            })
            .then(done)
            .catch(done)

          client.search({
            index: 'logstash-2000.01.01',
            body: {}
          }, () => {})
        })

        it('should set the correct tags', done => {
          agent
            .use(traces => {
              expect(last(traces[0]).meta).to.have.property('db.type', 'elasticsearch')
              expect(last(traces[0]).meta).to.have.property('span.kind', 'client')
              expect(last(traces[0]).meta).to.have.property('elasticsearch.method', 'POST')
              expect(last(traces[0]).meta).to.have.property('elasticsearch.url', '/docs/_search')
              expect(last(traces[0]).meta).to.have.property('elasticsearch.body', '{"query":{"match_all":{}}}')
              expect(last(traces[0]).meta).to.have.property('elasticsearch.params', '{"sort":"name","size":100}')
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
          }, () => {})
        })

        it('should set the correct tags on msearch', done => {
          agent
            .use(traces => {
              expect(last(traces[0]).meta).to.have.property('db.type', 'elasticsearch')
              expect(last(traces[0]).meta).to.have.property('span.kind', 'client')
              expect(last(traces[0]).meta).to.have.property('elasticsearch.method', 'POST')
              expect(last(traces[0]).meta).to.have.property('elasticsearch.url', '/_msearch')
              expect(last(traces[0]).meta).to.have.property(
                'elasticsearch.body',
                '[{"index":"docs"},{"query":{"match_all":{}}},{"index":"docs2"},{"query":{"match_all":{}}}]'
              )
              expect(last(traces[0]).meta).to.have.property('elasticsearch.params', '{"size":100}')
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
          }, () => {})
        })

        it('should skip tags for unavailable fields', done => {
          agent
            .use(traces => {
              expect(last(traces[0]).meta).to.not.have.property('elasticsearch.body')
            })
            .then(done)
            .catch(done)

          client.ping(err => err && done(err))
        })

        describe('when using a callback', () => {
          it('should do automatic instrumentation', done => {
            agent
              .use(traces => {
                expect(last(traces[0])).to.have.property('service', 'test-elasticsearch')
                expect(last(traces[0])).to.have.property('resource', 'HEAD /')
                expect(last(traces[0])).to.have.property('type', 'elasticsearch')
              })
              .then(done)
              .catch(done)

            client.ping(err => err && done(err))
          })

          it('should propagate context', done => {
            agent
              .use(traces => {
                expect(last(traces[0])).to.have.property('parent_id')
                expect(last(traces[0]).parent_id).to.not.be.null
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
              .use(traces => {
                expect(last(traces[0]).meta).to.have.property('error.type', error.name)
                expect(last(traces[0]).meta).to.have.property('error.msg', error.message)
                expect(last(traces[0]).meta).to.have.property('error.stack', error.stack)
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

        describe('when using a promise', () => {
          it('should do automatic instrumentation', done => {
            agent
              .use(traces => {
                expect(last(traces[0])).to.have.property('service', 'test-elasticsearch')
                expect(last(traces[0])).to.have.property('resource', 'HEAD /')
                expect(last(traces[0])).to.have.property('type', 'elasticsearch')
              })
              .then(done)
              .catch(done)

            client.ping().catch(done)
          })

          it('should propagate context', done => {
            agent
              .use(traces => {
                expect(last(traces[0])).to.have.property('parent_id')
                expect(last(traces[0]).parent_id).to.not.be.null
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
              expect(last(traces[0]).meta).to.have.property('error.type', error.name)
              expect(last(traces[0]).meta).to.have.property('error.msg', error.message)
              expect(last(traces[0]).meta).to.have.property('error.stack', error.stack)
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
        })
      })

      describe('with configuration', () => {
        let client

        before(() => {
          return agent.load('elasticsearch', {
            service: 'test',
            hooks: { query: (span, params) => {
              span.addTags({ 'elasticsearch.params': 'foo', 'elasticsearch.method': params.method })
            } }
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
          }, () => {})

          agent
            .use(traces => {
              expect(last(traces[0])).to.have.property('service', 'test')
              expect(last(traces[0]).meta).to.have.property('elasticsearch.params', 'foo')
              expect(last(traces[0]).meta).to.have.property('elasticsearch.method', 'POST')
            })
            .then(done)
            .catch(done)

          client.ping(err => err && done(err))
        })
      })
    })
  })
})
