'use strict'

const axios = require('axios')
const semver = require('semver')
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

describe('URI sourcing with express', () => {
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

    it('should taint uri', (done) => {
      const app = express()
      const pathPattern = semver.intersects(version, '>=5.0.0') ? '/path/*splat' : '/path/*'
      app.get(pathPattern, (req, res) => {
        const store = storage('legacy').getStore()
        const iastContext = iastContextFunctions.getIastContext(store)
        const isPathTainted = isTainted(iastContext, req.url)
        expect(isPathTainted).to.be.true
        const taintedPathValueRanges = getRanges(iastContext, req.url)
        expect(taintedPathValueRanges[0].iinfo.type).to.be.equal(HTTP_REQUEST_URI)
        res.status(200).send()
      })

      appListener = app.listen(0, 'localhost', () => {
        const port = appListener.address().port

        axios
          .get(`http://localhost:${port}/path/vulnerable`)
          .then(() => done())
          .catch(done)
      })
    })
  })
})

describe('Path params sourcing with express', () => {
  let express
  let expressVersion
  let appListener

  withVersions('express', 'express', version => {
    const checkParamIsTaintedAndNext = (req, res, next, param, name) => {
      const store = storage('legacy').getStore()
      const iastContext = iastContextFunctions.getIastContext(store)

      const pathParamValue = name ? req.params[name] : req.params
      const isParameterTainted = isTainted(iastContext, pathParamValue)
      expect(isParameterTainted).to.be.true
      const taintedParameterValueRanges = getRanges(iastContext, pathParamValue)
      expect(taintedParameterValueRanges[0].iinfo.type).to.be.equal(HTTP_REQUEST_PATH_PARAM)

      next()
    }

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

      const expressRequire = require(`../../../../../../../versions/express@${version}`)
      express = expressRequire.get()
      expressVersion = expressRequire.version()
    })

    afterEach(() => {
      appListener && appListener.close()
      appListener = null

      iast.disable()
    })

    it('should taint path params', function (done) {
      const app = express()
      app.get('/:parameter1/:parameter2', (req, res) => {
        const store = storage('legacy').getStore()
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

      appListener = app.listen(0, 'localhost', () => {
        const port = appListener.address().port

        axios
          .get(`http://localhost:${port}/tainted1/tainted2`)
          .then(() => done())
          .catch(done)
      })
    })

    it('should taint path params in nested routers with merged params', function (done) {
      if (!semver.satisfies(expressVersion, '>4.5.0')) {
        this.skip()
      }

      const app = express()
      const nestedRouter = express.Router({ mergeParams: true })

      nestedRouter.get('/:parameterChild', (req, res) => {
        const store = storage('legacy').getStore()
        const iastContext = iastContextFunctions.getIastContext(store)

        for (const pathParamName of ['parameterParent', 'parameterChild']) {
          const pathParamValue = req.params[pathParamName]
          const isParameterTainted = isTainted(iastContext, pathParamValue)
          expect(isParameterTainted).to.be.true
          const taintedParameterValueRanges = getRanges(iastContext, pathParamValue)
          expect(taintedParameterValueRanges[0].iinfo.type).to.be.equal(HTTP_REQUEST_PATH_PARAM)
        }

        res.status(200).send()
      })

      app.use('/:parameterParent', nestedRouter)

      appListener = app.listen(0, 'localhost', () => {
        const port = appListener.address().port

        axios
          .get(`http://localhost:${port}/tainted1/tainted2`)
          .then(() => done())
          .catch(done)
      })
    })

    it('should taint path param on router.params callback', function (done) {
      const app = express()

      app.use('/:parameter1/:parameter2', (req, res) => {
        res.status(200).send()
      })

      app.param(['parameter1', 'parameter2'], checkParamIsTaintedAndNext)

      appListener = app.listen(0, 'localhost', () => {
        const port = appListener.address().port

        axios
          .get(`http://localhost:${port}/tainted1/tainted2`)
          .then(() => done())
          .catch(done)
      })
    })

    it('should taint path param on router.params callback with custom implementation', function (done) {
      if (!semver.satisfies(expressVersion, '4')) {
        this.skip()
      }
      const app = express()

      app.use('/:parameter1/:parameter2', (req, res) => {
        res.status(200).send()
      })

      app.param((param, option) => {
        return checkParamIsTaintedAndNext
      })

      app.param('parameter1')
      app.param('parameter2')

      appListener = app.listen(0, 'localhost', () => {
        const port = appListener.address().port

        axios
          .get(`http://localhost:${port}/tainted1/tainted2`)
          .then(() => done())
          .catch(done)
      })
    })
  })
})
