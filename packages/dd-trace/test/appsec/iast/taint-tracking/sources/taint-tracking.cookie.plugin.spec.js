'use strict'

const axios = require('axios')
const Config = require('../../../../../src/config')
const { storage } = require('../../../../../../datadog-core')
const iast = require('../../../../../src/appsec/iast')
const iastContextFunctions = require('../../../../../src/appsec/iast/iast-context')
const { isTainted, getRanges } = require('../../../../../src/appsec/iast/taint-tracking/operations')
const { withVersions } = require('../../../../setup/mocha')
const {
  HTTP_REQUEST_COOKIE_NAME,
  HTTP_REQUEST_COOKIE_VALUE
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
        expect(isCookieValueTainted).to.be.true
        const taintedCookieValueRanges = getRanges(iastContext, cookieValue)
        expect(taintedCookieValueRanges[0].iinfo.type).to.be.equal(HTTP_REQUEST_COOKIE_VALUE)
        const isCookieNameTainted = isTainted(iastContext, cookieName)
        expect(isCookieNameTainted).to.be.true
        const taintedCookieNameRanges = getRanges(iastContext, cookieName)
        expect(taintedCookieNameRanges[0].iinfo.type).to.be.equal(HTTP_REQUEST_COOKIE_NAME)
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
