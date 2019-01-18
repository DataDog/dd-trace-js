'use strict'

const agent = require('./agent')
const plugin = require('../../src/plugins/elasticsearch')

wrapIt()

describe('Plugin', () => {
  let elasticsearch
  let tracer

  withVersions(plugin, 'elasticsearch', version => {
    describe('elasticsearch', () => {
      beforeEach(() => {
        tracer = require('../..')
      })

      describe('without configuration', () => {
        let client

        before(() => {
          return agent.load(plugin, 'elasticsearch')
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          elasticsearch = require(`../../versions/elasticsearch@${version}`).get()
          client = new elasticsearch.Client({
            host: 'localhost:9200',
            defer: () => {
              const deferred = {}

              deferred.promise = new Promise((resolve, reject) => {
                deferred.resolve = resolve
                deferred.reject = reject
              })

              deferred.promise.test = true

              return deferred
            }
          })
        })

        it('should sanitize the resource name', done => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('resource', 'POST /logstash-?.?.?/_search')
            })
            .then(done)
            .catch(done)

          client.search({ index: 'logstash-2000.01.01' }, () => {})
        })

        it('should set the correct tags', done => {
          agent
            .use(traces => {
              expect(traces[0][0].meta).to.have.property('db.type', 'elasticsearch')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('elasticsearch.method', 'POST')
              expect(traces[0][0].meta).to.have.property('elasticsearch.url', '/docs/_search')
              expect(traces[0][0].meta).to.have.property('elasticsearch.body', '{"query":{"match_all":{}}}')
              expect(traces[0][0].meta).to.have.property('elasticsearch.params', '{"sort":"name","size":100}')
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

        it('should skip tags for unavailable fields', done => {
          agent
            .use(traces => {
              expect(traces[0][0].meta).to.not.have.property('elasticsearch.body')
            })
            .then(done)
            .catch(done)

          client.ping(err => err && done(err))
        })

        describe('when using a callback', () => {
          it('should do automatic instrumentation', done => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('service', 'test-elasticsearch')
                expect(traces[0][0]).to.have.property('resource', 'HEAD /')
                expect(traces[0][0]).to.have.property('type', 'elasticsearch')
              })
              .then(done)
              .catch(done)

            client.ping(err => err && done(err))
          })

          it('should propagate context', done => {
            if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

            agent
              .use(traces => {
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
            if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

            client.ping(error => {
              expect(tracer.scope().active()).to.be.null
              done(error)
            })
          })

          it('should handle errors', done => {
            let error

            agent
              .use(traces => {
                expect(traces[0][0].meta).to.have.property('error.type', error.name)
                expect(traces[0][0].meta).to.have.property('error.msg', error.message)
                expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
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
                expect(traces[0][0]).to.have.property('service', 'test-elasticsearch')
                expect(traces[0][0]).to.have.property('resource', 'HEAD /')
                expect(traces[0][0]).to.have.property('type', 'elasticsearch')
              })
              .then(done)
              .catch(done)

            client.ping().catch(done)
          })

          it('should propagate context', done => {
            if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

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

          it('should run resolved promises in the parent context', () => {
            if (process.env.DD_CONTEXT_PROPAGATION === 'false') return

            return client.ping()
              .then(() => {
                expect(tracer.scope().active()).to.be.null
              })
          })

          it('should run rejected promises in the parent context', done => {
            if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

            client.search({ index: 'invalid' })
              .catch(() => {
                expect(tracer.scope().active()).to.be.null
                done()
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
              client.ping().abort()
            }).not.to.throw()
          })

          it('should not override the returned promise', () => {
            const promise = client.ping()

            return promise.then(() => {
              expect(promise).to.have.property('test', true)
            })
          })
        })
      })

      describe('with configuration', () => {
        let client

        before(() => {
          return agent.load(plugin, 'elasticsearch', { service: 'test' })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          elasticsearch = require(`../../versions/elasticsearch@${version}`).get()
          client = new elasticsearch.Client({
            host: 'localhost:9200'
          })
        })

        it('should be configured with the correct values', done => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', 'test')
            })
            .then(done)
            .catch(done)

          client.ping(err => err && done(err))
        })
      })
    })
  })
})
