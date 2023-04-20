'use strict'

const axios = require('axios')
const getPort = require('get-port')
const agent = require('../../../../plugins/agent')
const Config = require('../../../../../src/config')
const { storage } = require('../../../../../../datadog-core')
const iast = require('../../../../../src/appsec/iast')
const iastContextFunctions = require('../../../../../src/appsec/iast/iast-context')
const { isTainted, getRanges } = require('../../../../../src/appsec/iast/taint-tracking/operations')
const { HTTP_REQUEST_PATH_PARAM } = require('../../../../../src/appsec/iast/taint-tracking/origin-types')

describe('Path params sourcing with express', () => {
  let express
  let appListener

  withVersions('express', 'express', version => {
    before(() => {
      return agent.load(['http', 'express'], { client: false })
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

      express = require(`../../../../../../../versions/express@${version}`).get()
    })

    afterEach(() => {
      appListener && appListener.close()
      appListener = null

      iast.disable()
    })

    it('should taint path params', done => {
      const app = express()
      app.get('/:parameter1/:parameter2', (req, res) => {
        const store = storage.getStore()
        const iastContext = iastContextFunctions.getIastContext(store)

        for (const pathParamName of ['parameter1', 'parameter2']) {
          const pathParamValue = req.params[pathParamName]
          const isParameterTainted = isTainted(iastContext, pathParamValue)
          expect(isParameterTainted).to.be.true
          const taintedParameterValueRanges = getRanges(iastContext, pathParamValue)
          expect(taintedParameterValueRanges[0].iinfo.type).to.be.equal(HTTP_REQUEST_PATH_PARAM)
        }

        res.status(200).send()
      })

      getPort().then(port => {
        appListener = app.listen(port, 'localhost', () => {
          axios
            .get(`http://localhost:${port}/tainted1/tainted2`)
            .then(() => done())
            .catch(done)
        })
      })
    })
  })
})
