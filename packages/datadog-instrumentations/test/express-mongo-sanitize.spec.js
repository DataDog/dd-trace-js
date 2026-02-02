'use strict'

const assert = require('node:assert/strict')

const axios = require('axios')

const { channel } = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

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

        server = app.listen(0, () => {
          port = (/** @type {import('net').AddressInfo} */ (server.address())).port
          done()
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
          assert.strictEqual(sanitizeMiddlewareFinished.hasSubscribers, false)

          await axios.get(`http://localhost:${port}/?param=paramvalue`)

          sinon.assert.calledOnce(requestBody)
          assert.strictEqual(requestBody.firstCall.args[0].query.param, 'paramvalue')
        })

        it('it continues working with sanitization request', async () => {
          assert.strictEqual(sanitizeMiddlewareFinished.hasSubscribers, false)

          await axios.get(`http://localhost:${port}/?param[$eq]=paramvalue`)

          sinon.assert.calledOnce(requestBody)
          assert.strictEqual(requestBody.firstCall.args[0].query.param.$eq, undefined)
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
          assert.strictEqual(sanitizeMiddlewareFinished.hasSubscribers, true)

          await axios.get(`http://localhost:${port}/?param=paramvalue`)

          sinon.assert.calledOnce(requestBody)
          assert.strictEqual(requestBody.firstCall.args[0].query.param, 'paramvalue')
        })

        it('it continues working with sanitization request', async () => {
          assert.strictEqual(sanitizeMiddlewareFinished.hasSubscribers, true)

          await axios.get(`http://localhost:${port}/?param[$eq]=paramvalue`)

          sinon.assert.calledOnce(requestBody)
          assert.strictEqual(requestBody.firstCall.args[0].query.param.$eq, undefined)
        })

        it('subscription is called with expected parameters without sanitization request', async () => {
          assert.strictEqual(sanitizeMiddlewareFinished.hasSubscribers, true)

          await axios.get(`http://localhost:${port}/?param=paramvalue`)

          sinon.assert.calledOnce(subscription)
          assert.deepStrictEqual(
            subscription.firstCall.args[0].sanitizedProperties,
            ['body', 'params', 'headers', 'query'],
          )
          assert.strictEqual(subscription.firstCall.args[0].req.query.param, 'paramvalue')
        })

        it('subscription is called with expected parameters with sanitization request', async () => {
          assert.strictEqual(sanitizeMiddlewareFinished.hasSubscribers, true)

          await axios.get(`http://localhost:${port}/?param[$eq]=paramvalue`)

          sinon.assert.calledOnce(subscription)
          assert.deepStrictEqual(
            subscription.firstCall.args[0].sanitizedProperties,
            ['body', 'params', 'headers', 'query'],
            'Sanitized properties should be called with expected parameters'
          )
          assert.strictEqual(subscription.firstCall.args[0].req.query.param.$eq, undefined)
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
          assert.strictEqual(sanitizeFinished.hasSubscribers, false)

          const objectToSanitize = {
            safeKey: 'safeValue',
          }

          const sanitizedObject = expressMongoSanitize.sanitize(objectToSanitize)

          assert.strictEqual(sanitizedObject.safeKey, objectToSanitize.safeKey)
        })

        it('it works as expected with modifications', () => {
          assert.strictEqual(sanitizeFinished.hasSubscribers, false)

          const objectToSanitize = {
            unsafeKey: {
              $ne: 'test',
            },
            safeKey: 'safeValue',
          }

          const sanitizedObject = expressMongoSanitize.sanitize(objectToSanitize)

          assert.strictEqual(sanitizedObject.safeKey, objectToSanitize.safeKey)
          assert.strictEqual(sanitizedObject.unsafeKey.$ne, undefined)
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
          assert.strictEqual(sanitizeFinished.hasSubscribers, true)

          const objectToSanitize = {
            safeKey: 'safeValue',
          }

          const sanitizedObject = expressMongoSanitize.sanitize(objectToSanitize)

          assert.strictEqual(sanitizedObject.safeKey, objectToSanitize.safeKey)
          sinon.assert.calledOnceWithMatch(subscription, { sanitizedObject })
        })

        it('it works as expected with modifications', () => {
          assert.strictEqual(sanitizeFinished.hasSubscribers, true)

          const objectToSanitize = {
            unsafeKey: {
              $ne: 'test',
            },
            safeKey: 'safeValue',
          }

          const sanitizedObject = expressMongoSanitize.sanitize(objectToSanitize)

          assert.strictEqual(sanitizedObject.safeKey, objectToSanitize.safeKey)
          assert.strictEqual(sanitizedObject.unsafeKey.$ne, undefined)
          sinon.assert.calledOnceWithMatch(subscription, { sanitizedObject })
        })
      })
    })
  })
})
