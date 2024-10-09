'use strict'

const { prepareTestServerForIast } = require('../utils')
const Analyzer = require('../../../../src/appsec/iast/analyzers/vulnerability-analyzer')
const { INSECURE_COOKIE } = require('../../../../src/appsec/iast/vulnerabilities')
const insecureCookieAnalyzer = require('../../../../src/appsec/iast/analyzers/insecure-cookie-analyzer')
const CookieAnalyzer = require('../../../../src/appsec/iast/analyzers/cookie-analyzer')

const analyzer = new Analyzer()

describe('insecure cookie analyzer', () => {
  it('Expected vulnerability identifier', () => {
    expect(INSECURE_COOKIE).to.be.equals('INSECURE_COOKIE')
  })

  it('InsecureCookieAnalyzer extends CookieAnalyzer', () => {
    expect(CookieAnalyzer.isPrototypeOf(insecureCookieAnalyzer.constructor)).to.be.true
  })

  // In these test, even when we are having multiple vulnerabilities, all the vulnerabilities
  // are in the same cookies method, and it is expected to detect both even when the max operations is 1
  const iastConfig = {
    enabled: true,
    requestSampling: 100,
    maxConcurrentRequests: 1,
    maxContextOperations: 1
  }

  prepareTestServerForIast('insecure cookie analyzer',
    (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('set-cookie', 'key=value')
      }, INSECURE_COOKIE, 1, function (vulnerabilities) {
        expect(vulnerabilities[0].evidence.value).to.be.equals('key')
        expect(vulnerabilities[0].hash).to.be.equals(analyzer._createHash('INSECURE_COOKIE:key'))
      })

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('set-cookie', ['key=value'])
      }, INSECURE_COOKIE, 1)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('set-cookie', ['key=value', 'key2=value2'])
      }, INSECURE_COOKIE, 2)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('set-cookie', ['key=value', 'key2=value2; Secure'])
      }, INSECURE_COOKIE, 1)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('set-cookie', ['key=value; HttpOnly', 'key2=value2; Secure'])
      }, INSECURE_COOKIE, 1)

      testThatRequestHasVulnerability((req, res) => {
        const cookieNamePrefix = '0'.repeat(32)
        res.setHeader('set-cookie', [cookieNamePrefix + 'key1=value', cookieNamePrefix + 'key2=value2'])
      }, INSECURE_COOKIE, 1, undefined, undefined,
      'Should be detected as the same INSECURE_COOKIE vulnerability when the cookie name is long')

      testThatRequestHasNoVulnerability((req, res) => {
        res.setHeader('set-cookie', 'key=value; Secure')
      }, INSECURE_COOKIE)

      testThatRequestHasNoVulnerability((req, res) => {
        res.setHeader('set-cookie', 'key=')
      }, INSECURE_COOKIE)
    }, iastConfig)
})
