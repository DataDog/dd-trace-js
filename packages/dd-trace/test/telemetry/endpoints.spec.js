'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const dc = require('dc-polyfill')

require('../setup/core')

const originalSetImmediate = global.setImmediate

describe('endpoints telemetry', () => {
  const fastifyRouteCh = dc.channel('apm:fastify:route:added')
  const expressRouteCh = dc.channel('apm:express:route:add')
  const application = 'test'
  const host = 'host'

  describe('start', () => {
    const subscribe = sinon.stub()
    const dc = { channel () { return { subscribe } } }
    const endpoints = proxyquire('../../src/telemetry/endpoints', {
      'dc-polyfill': dc
    })

    beforeEach(() => {
      sinon.reset()
    })

    it('should subscribe', () => {
      const config = { appsec: { apiSecurity: { endpointCollectionEnabled: true } } }
      endpoints.start(config)

      expect(subscribe).to.have.been.calledTwice
    })

    it('should not subscribe', () => {
      const config = { appsec: { apiSecurity: { endpointCollectionEnabled: false } } }
      endpoints.start(config)

      expect(subscribe).to.not.have.been.called
    })
  })

  describe('on events', () => {
    let endpoints
    let sendData
    let getRetryData
    let updateRetryData
    let scheduledCallbacks

    beforeEach(() => {
      sendData = sinon.stub()
      getRetryData = sinon.stub()
      updateRetryData = sinon.stub()

      endpoints = proxyquire('../../src/telemetry/endpoints', {
        './send-data': { sendData }
      })
      scheduledCallbacks = []
      global.setImmediate = function (callback) {
        scheduledCallbacks.push(callback)
        return { unref () {} }
      }

      const config = {
        appsec: {
          apiSecurity: {
            endpointCollectionEnabled: true,
            endpointCollectionMessageLimit: 100
          }
        }
      }

      endpoints.start(config, application, host, getRetryData, updateRetryData)
    })

    afterEach(() => {
      endpoints.stop()
      sendData.reset()
      getRetryData.reset()
      updateRetryData.reset()
      global.setImmediate = originalSetImmediate
    })

    it('should not fail with invalid data', () => {
      fastifyRouteCh.publish(null)
      fastifyRouteCh.publish({})
      fastifyRouteCh.publish({ routeOptions: {} })
    })

    it('should record fastify methods array', () => {
      fastifyRouteCh.publish({ routeOptions: { method: ['GET', 'post'], path: '/api' } })
      fastifyRouteCh.publish({ routeOptions: { method: 'GET', path: '/api' } })
      fastifyRouteCh.publish({ routeOptions: { method: 'POST', path: '/api' } })
      fastifyRouteCh.publish({ routeOptions: { method: 'PUT', path: '/api' } })

      scheduledCallbacks.forEach(cb => cb())

      expect(sendData).to.have.been.calledOnce
      const payload = sendData.firstCall.args[4]
      expect(payload.endpoints).to.have.deep.members([
        {
          type: 'REST',
          method: 'GET',
          path: '/api',
          operation_name: 'http.request',
          resource_name: 'GET /api'
        },
        {
          type: 'REST',
          method: 'POST',
          path: '/api',
          operation_name: 'http.request',
          resource_name: 'POST /api'
        },
        {
          type: 'REST',
          method: 'PUT',
          path: '/api',
          operation_name: 'http.request',
          resource_name: 'PUT /api'
        }
      ])
    })

    it('should set is_first=true only for the first payload', () => {
      fastifyRouteCh.publish({ routeOptions: { method: 'GET', path: '/one' } })
      scheduledCallbacks.forEach(cb => cb())

      fastifyRouteCh.publish({ routeOptions: { method: 'POST', path: '/two' } })
      scheduledCallbacks.forEach(cb => cb())

      expect(sendData.callCount).to.equal(2)
      const firstPayload = sendData.firstCall.args[4]
      const secondPayload = sendData.secondCall.args[4]

      expect(firstPayload).to.have.property('is_first', true)
      expect(Boolean(secondPayload.is_first)).to.equal(false)
    })

    it('should send large amount of endpoints in small batches', () => {
      for (let i = 0; i < 150; i++) {
        fastifyRouteCh.publish({ routeOptions: { method: 'GET', path: '/' + i } })
      }

      scheduledCallbacks.forEach(cb => cb())
      scheduledCallbacks.forEach(cb => cb())

      expect(sendData.callCount).to.equal(2)
      const firstPayload = sendData.firstCall.args[4]
      const secondPayload = sendData.secondCall.args[4]

      expect(firstPayload.endpoints).to.have.length(100)
      expect(secondPayload.endpoints).to.have.length(50)
    })

    it('should record express route and add HEAD for GET', () => {
      expressRouteCh.publish({ method: 'GET', path: '/test' })

      scheduledCallbacks.forEach(cb => cb())

      expect(sendData).to.have.been.calledOnce
      const payload = sendData.firstCall.args[4]
      const resources = payload.endpoints.map(e => e.resource_name)
      expect(resources).to.include('GET /test')
      expect(resources).to.include('HEAD /test')
    })

    it('should record express wildcard and ignore subsequent specific methods for same path', () => {
      expressRouteCh.publish({ method: '*', path: '/all' })
      expressRouteCh.publish({ method: 'GET', path: '/all' })
      expressRouteCh.publish({ method: 'POST', path: '/all' })

      scheduledCallbacks.forEach(cb => cb())

      expect(sendData).to.have.been.calledOnce
      const payload = sendData.firstCall.args[4]
      const resources = payload.endpoints.map(e => e.resource_name)
      expect(resources).to.deep.equal(['* /all'])
    })

    describe('on failed request', () => {
      let capturedRequestType

      beforeEach(() => {
        capturedRequestType = undefined

        sendData.callsFake((config, application, host, reqType, payload, cb = () => {}) => {
          capturedRequestType = reqType
          cb(new Error('HTTP request error'), { payload, reqType })
        })
      })

      it('should update retry data', () => {
        fastifyRouteCh.publish({ routeOptions: { method: 'GET', path: '/r' } })

        scheduledCallbacks.forEach(cb => cb())

        expect(getRetryData).to.have.been.calledOnce
        expect(capturedRequestType).to.equal('app-endpoints')
        expect(updateRetryData).to.have.been.calledOnce
      })

      it('should create batch request when retry data exists', () => {
        fastifyRouteCh.publish({ routeOptions: { method: 'GET', path: '/first' } })

        scheduledCallbacks.forEach(cb => cb())

        expect(getRetryData).to.have.been.calledOnce
        expect(capturedRequestType).to.equal('app-endpoints')

        getRetryData.returns({
          reqType: 'app-endpoints',
          payload: { endpoints: [] }
        })

        fastifyRouteCh.publish({ routeOptions: { method: 'POST', path: '/second' } })
        scheduledCallbacks.forEach(cb => cb())
        expect(getRetryData).to.have.been.calledTwice
        expect(capturedRequestType).to.equal('message-batch')
        expect(updateRetryData).to.have.been.calledTwice
      })
    })
  })
})
