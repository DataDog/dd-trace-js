'use strict'

const assert = require('node:assert/strict')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
describe('Plugin', () => {
  let ShareDB

  describe('sharedb', () => {
    withVersions('sharedb', 'sharedb', version => {
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
          return agent.close({ ritmReset: false })
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

            agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].service, 'test')
              assert.strictEqual(traces[0][0].resource, 'fetch some-collection')
              assert.strictEqual(traces[0][0].meta['span.kind'], 'server')
              assert.strictEqual(traces[0][0].meta.service, 'test')
              assert.strictEqual(traces[0][0].meta['sharedb.action'], 'fetch')
              assert.strictEqual(traces[0][0].meta.component, 'sharedb')
              assert.strictEqual(traces[0][0].meta['_dd.integration'], 'sharedb')
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

            agent.assertSomeTraces(traces => {
              sinon.assert.calledWithMatch(receiveSpy, sinon.match.object, sinon.match.func)
              sinon.assert.calledWithMatch(replySpy, sinon.match.object, sinon.match.func)
              assert.strictEqual(traces[0][0].service, 'test')
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

            agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].service, 'test')
              assert.ok('resource' in traces[0][0])
              assert.strictEqual(
                traces[0][0].resource,
                'query-fetch some-collection {"randomValues":{"property":"?","one":"?"}}'
              )
              assert.strictEqual(traces[0][0].meta['span.kind'], 'server')
              assert.strictEqual(traces[0][0].meta.service, 'test')
              assert.strictEqual(traces[0][0].meta['sharedb.action'], 'query-fetch')
              assert.strictEqual(traces[0][0].meta.component, 'sharedb')
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

        it('should propagate the parent tracing context', (done) => {
          const doc = connection.get('some-collection', 'some-id')

          const tracer = require('../../dd-trace')
          const firstSpan = tracer.scope().active()
          doc.fetch(function (err) {
            if (err) { throw err }

            assert.strictEqual(tracer.scope().active(), firstSpan)
            done()
          })
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
          return agent.close({ ritmReset: false })
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

            agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].service, 'test-sharedb')
              sinon.assert.calledWithMatch(receiveHookSpy, sinon.match.object, sinon.match.object)
              sinon.assert.calledWithMatch(replyHookSpy,
                sinon.match.object,
                sinon.match.object,
                sinon.match.object
              )
            })
              .then(done)
              .catch(done)
          })
        })
      })

      describe('when the datastore throws an exception', () => {
        let backend
        let connection
        let receiveHookSpy
        let replyHookSpy

        before(() => {
          receiveHookSpy = sinon.spy()
          replyHookSpy = sinon.spy()
          return agent.load('sharedb', {
            hooks: {
              receive: receiveHookSpy,
              reply: replyHookSpy
            }
          })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          ShareDB = require(`../../../versions/sharedb@${version}`).get()

          backend = new ShareDB({ presence: true })

          backend.db.getSnapshot = function (collection, id, fields, options, callback) {
            callback(new Error('Snapshot Fetch Failure'))
          }

          connection = backend.connect()
        })

        afterEach(() => {
          connection.close()
        })

        it('should do automatic instrumentation & handle errors', done => {
          const doc = connection.get('some-collection', 'some-id')

          doc.fetch(function (err) {
            assert.notStrictEqual(err, null)
            assert.strictEqual(err.message, 'Snapshot Fetch Failure')

            agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].service, 'test')
              assert.strictEqual(traces[0][0].resource, 'fetch some-collection')
              assert.strictEqual(traces[0][0].meta['span.kind'], 'server')
              assert.strictEqual(traces[0][0].meta.service, 'test')
              assert.strictEqual(traces[0][0].meta['sharedb.action'], 'fetch')
              assert.strictEqual(traces[0][0].meta[ERROR_TYPE], 'Error')
              assert.strictEqual(traces[0][0].meta[ERROR_MESSAGE], 'Snapshot Fetch Failure')
              assert.ok(Object.hasOwn(traces[0][0].meta, ERROR_STACK))
              assert.strictEqual(traces[0][0].meta.component, 'sharedb')
            })
              .then(done)
              .catch(done)
          })
        })
      })
    })
  })
})
