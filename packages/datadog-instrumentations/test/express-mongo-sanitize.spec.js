'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const getPort = require('get-port')
const { channel } = require('../../diagnostics_channel')
const axios = require('axios')
describe('express-mongo-sanitize', () => {
  withVersions('express-mongo-sanitize', 'express-mongo-sanitize', version => {
    describe('middleware', () => {
      const sanitizeMiddlewareFinished = channel('datadog:express-mongo-sanitize:filter:finish')
      let port, server, requestBody

      before(() => {
        return agent.load(['express', 'express-mongo-sanitize'], { client: false })
      })

      before((done) => {
        const express = require('../../../versions/express').get()
        const expressMongoSanitize = require(`../../../versions/express-mongo-sanitize@${version}`).get()
        const app = express()

        app.use(expressMongoSanitize())
        app.all('/', (req, res) => {
          requestBody(req, res)
          res.end()
        })

        getPort().then(newPort => {
          port = newPort
          server = app.listen(port, () => {
            done()
          })
        })
      })

      beforeEach(() => {
        requestBody = sinon.stub()
      })

      after(() => {
        server.close()
        return agent.close({ ritmReset: false })
      })

      describe('without subscriptions', () => {
        it('it continues working without sanitization request', async () => {
          expect(sanitizeMiddlewareFinished.hasSubscribers).to.be.false

          await axios.get(`http://localhost:${port}/?param=paramvalue`)

          expect(requestBody).to.be.calledOnce
          expect(requestBody.firstCall.args[0].query.param).to.be.equal('paramvalue')
        })
        it('it continues working with sanitization request', async () => {
          expect(sanitizeMiddlewareFinished.hasSubscribers).to.be.false

          await axios.get(`http://localhost:${port}/?param[$eq]=paramvalue`)

          expect(requestBody).to.be.calledOnce
          expect(requestBody.firstCall.args[0].query.param['$eq']).to.be.undefined
        })
      })

      describe('with subscriptions', () => {
        let subscription

        beforeEach(() => {
          subscription = sinon.stub()
          sanitizeMiddlewareFinished.subscribe(subscription)
        })

        afterEach(() => {
          sanitizeMiddlewareFinished.unsubscribe(subscription)
        })

        it('it continues working without sanitization request', async () => {
          expect(sanitizeMiddlewareFinished.hasSubscribers).to.be.true

          await axios.get(`http://localhost:${port}/?param=paramvalue`)

          expect(requestBody).to.be.calledOnce
          expect(requestBody.firstCall.args[0].query.param).to.be.equal('paramvalue')
        })

        it('it continues working with sanitization request', async () => {
          expect(sanitizeMiddlewareFinished.hasSubscribers).to.be.true

          await axios.get(`http://localhost:${port}/?param[$eq]=paramvalue`)

          expect(requestBody).to.be.calledOnce
          expect(requestBody.firstCall.args[0].query.param['$eq']).to.be.undefined
        })

        it('subscription is called with expected parameters without sanitization request', async () => {
          expect(sanitizeMiddlewareFinished.hasSubscribers).to.be.true

          await axios.get(`http://localhost:${port}/?param=paramvalue`)

          expect(subscription).to.be.calledOnce
          expect(subscription.firstCall.args[0].sanitizedProperties)
            .to.be.deep.equal(['body', 'params', 'headers', 'query'])
          expect(subscription.firstCall.args[0].req.query.param).to.be.equal('paramvalue')
        })

        it('subscription is called with expected parameters with sanitization request', async () => {
          expect(sanitizeMiddlewareFinished.hasSubscribers).to.be.true

          await axios.get(`http://localhost:${port}/?param[$eq]=paramvalue`)

          expect(subscription).to.be.calledOnce
          expect(subscription.firstCall.args[0].sanitizedProperties)
            .to.be.deep.equal(['body', 'params', 'headers', 'query'])
          expect(subscription.firstCall.args[0].req.query.param['$eq']).to.be.undefined
        })
      })
    })

    describe('sanitize method', () => {
      const sanitizeFinished = channel('datadog:express-mongo-sanitize:sanitize:finish')
      let expressMongoSanitize

      before(() => {
        return agent.load(['express-mongo-sanitize'], { client: false })
      })

      before(() => {
        expressMongoSanitize = require(`../../../versions/express-mongo-sanitize@${version}`).get()
      })

      after(() => {
        return agent.close({ ritmReset: false })
      })

      describe('without subscriptions', () => {
        it('it works as expected without modifications', () => {
          expect(sanitizeFinished.hasSubscribers).to.be.false
          const objectToSanitize = {
            safeKey: 'safeValue'
          }

          const sanitizedObject = expressMongoSanitize.sanitize(objectToSanitize)

          expect(sanitizedObject.safeKey).to.be.equal(objectToSanitize.safeKey)
        })
        it('it works as expected with modifications', () => {
          expect(sanitizeFinished.hasSubscribers).to.be.false
          const objectToSanitize = {
            unsafeKey: {
              '$ne': 'test'
            },
            safeKey: 'safeValue'
          }

          const sanitizedObject = expressMongoSanitize.sanitize(objectToSanitize)

          expect(sanitizedObject.safeKey).to.be.equal(objectToSanitize.safeKey)
          expect(sanitizedObject.unsafeKey['$ne']).to.be.undefined
        })
      })

      describe('with subscriptions', () => {
        let subscription
        beforeEach(() => {
          subscription = sinon.stub()
          sanitizeFinished.subscribe(subscription)
        })

        afterEach(() => {
          sanitizeFinished.unsubscribe(subscription)
          subscription = undefined
        })

        it('it works as expected without modifications', () => {
          expect(sanitizeFinished.hasSubscribers).to.be.true
          const objectToSanitize = {
            safeKey: 'safeValue'
          }

          const sanitizedObject = expressMongoSanitize.sanitize(objectToSanitize)

          expect(sanitizedObject.safeKey).to.be.equal(objectToSanitize.safeKey)
          expect(subscription).to.be.calledOnceWith({ sanitizedObject })
        })

        it('it works as expected with modifications', () => {
          expect(sanitizeFinished.hasSubscribers).to.be.true
          const objectToSanitize = {
            unsafeKey: {
              '$ne': 'test'
            },
            safeKey: 'safeValue'
          }

          const sanitizedObject = expressMongoSanitize.sanitize(objectToSanitize)

          expect(sanitizedObject.safeKey).to.be.equal(objectToSanitize.safeKey)
          expect(sanitizedObject.unsafeKey['$ne']).to.be.undefined
          expect(subscription).to.be.calledOnceWith({ sanitizedObject })
        })
      })
    })
  })
})
