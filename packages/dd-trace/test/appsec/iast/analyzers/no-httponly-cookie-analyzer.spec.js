'use strict'

const { prepareTestServerForIast } = require('../utils')
const { NO_HTTPONLY_COOKIE } = require('../../../../src/appsec/iast/vulnerabilities')
const CookieAnalyzer = require('../../../../src/appsec/iast/analyzers/cookie-analyzer')
const noHttponlyCookieAnalyzer = require('../../../../src/appsec/iast/analyzers/no-httponly-cookie-analyzer')

describe('no HttpOnly cookie analyzer', () => {
  it('Expected vulnerability identifier', () => {
    expect(NO_HTTPONLY_COOKIE).to.be.equals('NO_HTTPONLY_COOKIE')
  })

  it('NoHttponlyCookieAnalyzer extends CookieAnalyzer', () => {
    expect(CookieAnalyzer.isPrototypeOf(noHttponlyCookieAnalyzer.constructor)).to.be.true
  })

  // In these test, even when we are having multiple vulnerabilities, all the vulnerabilities
  // are in the same cookies method, and it is expected to detect both even when the max operations is 1
  const iastConfig = {
    enabled: true,
    requestSampling: 100,
    maxConcurrentRequests: 1,
    maxContextOperations: 1
  }

  prepareTestServerForIast('no HttpOnly cookie analyzer',
    (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('set-cookie', 'key=value')
      }, NO_HTTPONLY_COOKIE, 1, function (vulnerabilities) {
        expect(vulnerabilities[0].evidence.value).to.be.equals('key')
      })

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('set-cookie', ['key=value'])
      }, NO_HTTPONLY_COOKIE, 1)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('set-cookie', ['key=value', 'key2=value2'])
      }, NO_HTTPONLY_COOKIE, 1)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('set-cookie', ['key=value', 'key2=value2; Secure'])
      }, NO_HTTPONLY_COOKIE, 1)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('set-cookie', ['key=value', 'key2=value2; HttpOnly'])
      }, NO_HTTPONLY_COOKIE, 1)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('set-cookie', ['key=value; HttpOnly', 'key2=value2; Secure'])
      }, NO_HTTPONLY_COOKIE, 1)

      testThatRequestHasVulnerability((req, res) => {
        const cookieNamePrefix = '0'.repeat(32)
        res.setHeader('set-cookie', [cookieNamePrefix + 'key1=value', cookieNamePrefix + 'key2=value2'])
      }, NO_HTTPONLY_COOKIE, 1, undefined, undefined,
      'Should be detected as the same NO_HTTPONLY_COOKIE vulnerability when the cookie name is long')

      testThatRequestHasNoVulnerability((req, res) => {
        res.setHeader('set-cookie', 'key=value; HttpOnly')
      }, NO_HTTPONLY_COOKIE)

      testThatRequestHasNoVulnerability((req, res) => {
        res.setHeader('set-cookie', 'key=')
      }, NO_HTTPONLY_COOKIE)
    }, iastConfig)
})
