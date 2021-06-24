'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

wrapIt()

describe('Plugin', () => {
  let ShareDB

  describe('sharedb', () => {
    withVersions(plugin, 'sharedb', version => {
      beforeEach(() => {
        require('../../dd-trace')
      })

      describe('without configuration', () => {
        let backend
        let connection

        before(() => {
          return agent.load('sharedb')
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          ShareDB = require(`../../../versions/sharedb@${version}`).get()

          backend = new ShareDB({ presence: true })
          connection = backend.connect()
        })

        afterEach(() => {
          connection.close()
        })

        it('should do automatic instrumentation', done => {
          const doc = connection.get('some-collection', 'some-id')

          doc.fetch(function (err) {
            if (err) { throw err }

            agent.use(traces => {
              expect(traces[0][0]).to.have.property('service', 'test-sharedb')
              expect(traces[0][0]).to.have.property('resource', 'fetch some-collection')
              expect(traces[0][0]).to.have.property('type', 'sharedb.request')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('service', 'test')
              expect(traces[0][0].meta).to.have.property('resource.method', 'fetch')
            })
              .then(done)
              .catch(done)
          })
        })

        it('should be compatible with existing middleware', done => {
          const receiveSpy = sinon.spy((request, next) => {
            next()
          })
          const replySpy = sinon.spy((request, next) => {
            next()
          })
          backend.use('receive', receiveSpy)
          backend.use('reply', replySpy)
          const doc = connection.get('some-collection', 'some-id')

          doc.fetch(function (err) {
            if (err) { throw err }

            agent.use(traces => {
              expect(receiveSpy).to.have.been.calledWithMatch(sinon.match.object, sinon.match.func)
              expect(replySpy).to.have.been.calledWithMatch(sinon.match.object, sinon.match.func)
              expect(traces[0][0]).to.have.property('service', 'test-sharedb')
            })
              .then(done)
              .catch(done)
          })
        })

        it('should sanitize queries', done => {
          connection.createFetchQuery('some-collection', {
            randomValues: {
              property: 'query',
              one: 1
            }
          }, {}, function (err) {
            if (err) { throw err }

            agent.use(traces => {
              expect(traces[0][0]).to.have.property('service', 'test-sharedb')
              expect(traces[0][0])
                .to
                .have
                .property('resource',
                  'query-fetch some-collection {"randomValues":{"property":"?","one":"?"}}')
              expect(traces[0][0]).to.have.property('type', 'sharedb.request')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('service', 'test')
              expect(traces[0][0].meta).to.have.property('resource.method', 'query-fetch')
            })
              .then(done)
              .catch(done)
          })
        })

        it('should gracefully handle an invalid or unsupported message action', done => {
          let isDone = false
          const receiveSpy = sinon.spy((request, next) => {
            next()
            if (!isDone) {
              done()
              isDone = true
            }
          })
          backend.use('receive', receiveSpy)
          const message = {
            data: {
              a: 'some-unsupported-action'
            }
          }

          backend.trigger(backend.MIDDLEWARE_ACTIONS.receive, {}, message, function noop () {})
        })

        it('should gracefully handle a message without data', done => {
          let isDone = false
          const receiveSpy = sinon.spy((request, next) => {
            next()
            if (!isDone) {
              done()
              isDone = true
            }
          })
          backend.use('receive', receiveSpy)
          const message = {}
          backend.trigger(backend.MIDDLEWARE_ACTIONS.receive, {}, message, function noop () {})
        })
      })

      describe('with configuration', () => {
        let backend
        let connection
        let receiveHookSpy
        let replyHookSpy

        before(() => {
          receiveHookSpy = sinon.spy()
          replyHookSpy = sinon.spy()
          return agent.load('sharedb', {
            service: 'test-sharedb',
            hooks: {
              receive: receiveHookSpy,
              reply: replyHookSpy
            }
          })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          ShareDB = require(`../../../versions/sharedb@${version}`).get()

          backend = new ShareDB({ presence: true })
          connection = backend.connect()
        })

        afterEach(() => {
          connection.close()
        })

        it('should support receive and reply hooks', done => {
          const doc = connection.get('some-collection', 'some-id')

          doc.fetch(function (err) {
            if (err) { throw err }

            agent.use(traces => {
              expect(traces[0][0]).to.have.property('service', 'test-sharedb')
              expect(receiveHookSpy).to.have.been.calledWithMatch(sinon.match.object, sinon.match.object)
              expect(replyHookSpy).to.have.been.calledWithMatch(sinon.match.object, sinon.match.object)
            })
              .then(done)
              .catch(done)
          })
        })
      })
    })
  })
})
