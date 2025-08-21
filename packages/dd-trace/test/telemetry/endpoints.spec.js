'use strict'

require('../setup/tap')

const proxyquire = require('proxyquire')
const dc = require('dc-polyfill')

const originalSetImmediate = global.setImmediate

describe('endpoints telemetry', () => {
  const fastifyRouteCh = dc.channel('apm:fastify:route:added')
  const application = 'test'
  const host = 'host'

  describe('start', () => {
    it('should subscribe', () => {
      const subscribe = sinon.stub()
      const dc = { channel () { return { subscribe } } }
      const endpoints = proxyquire('../../src/telemetry/endpoints', {
        'dc-polyfill': dc
      })

      const config = { appsec: { apiSecurity: { endpointCollectionEnabled: true } } }
      endpoints.start(config)

      expect(subscribe).to.have.been.calledOnce
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
      expect(payload.endpoints).to.be.deep.strict.equal([
        {
          type: 'REST',
          method: 'GET',
          path: '/api',
          operation_name: 'http.request',
          ressource_name: 'GET /api'
        },
        {
          type: 'REST',
          method: 'POST',
          path: '/api',
          operation_name: 'http.request',
          ressource_name: 'POST /api'
        },
        {
          type: 'REST',
          method: 'PUT',
          path: '/api',
          operation_name: 'http.request',
          ressource_name: 'PUT /api'
        },
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

      expect(sendData.callCount).to.equal(2)
      const firstPayload = sendData.firstCall.args[4]
      const secondPayload = sendData.secondCall.args[4]

      expect(firstPayload.endpoints).to.have.length(100)
      expect(secondPayload.endpoints).to.have.length(50)
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
