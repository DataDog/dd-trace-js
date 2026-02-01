'use strict'

const assert = require('node:assert/strict')

const axios = require('axios')
const { afterEach, beforeEach, describe, it } = require('mocha')

const { storage } = require('../../../../../../datadog-core')
const iast = require('../../../../../src/appsec/iast')
const iastContextFunctions = require('../../../../../src/appsec/iast/iast-context')
const { isTainted, getRanges } = require('../../../../../src/appsec/iast/taint-tracking/operations')
const { getConfigFresh } = require('../../../../helpers/config')
const { withVersions } = require('../../../../setup/mocha')
const {
  HTTP_REQUEST_COOKIE_NAME,
  HTTP_REQUEST_COOKIE_VALUE,
} = require('../../../../../src/appsec/iast/taint-tracking/source-types')
const { testInRequest } = require('../../utils')

describe('Cookies sourcing with cookies', () => {
  let cookie
  withVersions('cookie', 'cookie', version => {
    function app () {
      const store = storage('legacy').getStore()
      const iastContext = iastContextFunctions.getIastContext(store)

      const rawCookies = 'cookie=value'
      const parsedCookies = cookie.parse(rawCookies)
      Object.getOwnPropertySymbols(parsedCookies).forEach(cookieName => {
        const cookieValue = parsedCookies[cookieName]
        const isCookieValueTainted = isTainted(iastContext, cookieValue)
        assert.strictEqual(isCookieValueTainted, true)
        const taintedCookieValueRanges = getRanges(iastContext, cookieValue)
        assert.strictEqual(taintedCookieValueRanges[0].iinfo.type, HTTP_REQUEST_COOKIE_VALUE)
        const isCookieNameTainted = isTainted(iastContext, cookieName)
        assert.strictEqual(isCookieNameTainted, true)
        const taintedCookieNameRanges = getRanges(iastContext, cookieName)
        assert.strictEqual(taintedCookieNameRanges[0].iinfo.type, HTTP_REQUEST_COOKIE_NAME)
      })
    }

    function tests (config) {
      beforeEach(() => {
        iast.enable(getConfigFresh({
          experimental: {
            iast: {
              enabled: true,
              requestSampling: 100,
            },
          },
        }))

        cookie = require(`../../../../../../../versions/cookie@${version}`).get()
      })

      afterEach(() => {
        iast.disable()
      })

      it('should taint cookies', (done) => {
        axios.get(`http://localhost:${config.port}/`)
          .then(() => done())
          .catch(done)
      })
    }

    testInRequest(app, tests)
  })
})
