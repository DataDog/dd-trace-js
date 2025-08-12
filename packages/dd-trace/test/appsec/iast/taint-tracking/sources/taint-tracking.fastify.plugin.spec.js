'use strict'

const axios = require('axios')
const agent = require('../../../../plugins/agent')
const Config = require('../../../../../src/config')
const { storage } = require('../../../../../../datadog-core')
const iast = require('../../../../../src/appsec/iast')
const iastContextFunctions = require('../../../../../src/appsec/iast/iast-context')
const { isTainted, getRanges } = require('../../../../../src/appsec/iast/taint-tracking/operations')
const { withVersions } = require('../../../../setup/mocha')
const {
  HTTP_REQUEST_PATH_PARAM,
  HTTP_REQUEST_URI
} = require('../../../../../src/appsec/iast/taint-tracking/source-types')

describe('URI sourcing with fastify', () => {
  let fastify
  let appInstance

  withVersions('fastify', 'fastify', version => {
    before(() => {
      return agent.load(['http', 'fastify'], { client: false })
    })

    after(() => {
      return agent.close({ ritmReset: false })
    })

    beforeEach(() => {
      iast.enable(new Config({
        experimental: {
          iast: {
            enabled: true,
            requestSampling: 100
          }
        }
      }))

      fastify = require(`../../../../../../../versions/fastify@${version}`).get()
    })

    afterEach(() => {
      if (appInstance) {
        appInstance.close()
        appInstance = null
      }
      iast.disable()
    })

    it('should taint uri', async () => {
      appInstance = fastify()

      appInstance.get('/path/*', (request, reply) => {
        const store = storage('legacy').getStore()
        const iastContext = iastContextFunctions.getIastContext(store)
        const isPathTainted = isTainted(iastContext, request.raw.url)
        expect(isPathTainted).to.be.true
        const taintedPathValueRanges = getRanges(iastContext, request.raw.url)
        expect(taintedPathValueRanges[0].iinfo.type).to.be.equal(HTTP_REQUEST_URI)
        reply.code(200).send()
      })

      await appInstance.listen({ port: 0 })

      const port = appInstance.server.address().port

      const response = await axios
        .get(`http://localhost:${port}/path/vulnerable`)
      expect(response.status).to.be.equal(200)
    })
  })
})

describe('Path params sourcing with fastify', () => {
  let fastify
  let appInstance

  withVersions('fastify', 'fastify', version => {
    before(() => {
      return agent.load(['http', 'fastify'], { client: false })
    })

    after(() => {
      return agent.close({ ritmReset: false })
    })

    beforeEach(() => {
      iast.enable(new Config({
        experimental: {
          iast: {
            enabled: true,
            requestSampling: 100
          }
        }
      }))

      fastify = require(`../../../../../../../versions/fastify@${version}`).get()
    })

    afterEach(() => {
      if (appInstance) {
        appInstance.close()
        appInstance = null
      }
      iast.disable()
    })

    it('should taint path params', async () => {
      appInstance = fastify()

      appInstance.get('/:parameter1/:parameter2', (request, reply) => {
        const store = storage('legacy').getStore()
        const iastContext = iastContextFunctions.getIastContext(store)

        for (const pathParamName of ['parameter1', 'parameter2']) {
          const pathParamValue = request.params[pathParamName]
          const isParameterTainted = isTainted(iastContext, pathParamValue)
          expect(isParameterTainted).to.be.true
          const taintedParameterValueRanges = getRanges(iastContext, pathParamValue)
          expect(taintedParameterValueRanges[0].iinfo.type).to.be.equal(HTTP_REQUEST_PATH_PARAM)
        }

        reply.code(200).send()
      })

      await appInstance.listen({ port: 0 })

      const port = appInstance.server.address().port

      const response = await axios
        .get(`http://localhost:${port}/tainted1/tainted2`)
      expect(response.status).to.be.equal(200)
    })
  })
})
