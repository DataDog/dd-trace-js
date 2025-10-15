'use strict'

const axios = require('axios')
const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')

const Config = require('../../../../../src/config')
const { storage } = require('../../../../../../datadog-core')
const iast = require('../../../../../src/appsec/iast')
const iastContextFunctions = require('../../../../../src/appsec/iast/iast-context')
const { isTainted, getRanges } = require('../../../../../src/appsec/iast/taint-tracking/operations')
const { HTTP_REQUEST_HEADER_VALUE } = require('../../../../../src/appsec/iast/taint-tracking/source-types')
const { testInRequest } = require('../../utils')

describe('Headers sourcing', () => {
  function app (req) {
    const store = storage('legacy').getStore()
    const iastContext = iastContextFunctions.getIastContext(store)

    Object.keys(req.headers).forEach(headerName => {
      const headerValue = req.headers[headerName]
      const isHeaderValueTainted = isTainted(iastContext, headerValue)
      expect(isHeaderValueTainted).to.be.true
      const taintedHeaderValueRanges = getRanges(iastContext, headerValue)
      expect(taintedHeaderValueRanges[0].iinfo.type).to.be.equal(HTTP_REQUEST_HEADER_VALUE)
    })
  }

  function tests (config) {
    beforeEach(() => {
      iast.enable(new Config({
        experimental: {
          iast: {
            enabled: true,
            requestSampling: 100
          }
        }
      }))
    })

    afterEach(() => {
      iast.disable()
    })

    it('should taint headers', (done) => {
      axios.get(
        `http://localhost:${config.port}/`,
        {
          headers: {
            'x-iast-test-header': 'value to be tainted'
          }
        })
        .then(() => done())
        .catch(done)
    })
  }

  testInRequest(app, tests)
})
