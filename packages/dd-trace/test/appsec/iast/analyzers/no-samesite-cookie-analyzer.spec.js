'use strict'

const { expect } = require('chai')
const { describe, it } = require('mocha')

const { prepareTestServerForIast } = require('../utils')
const { NO_SAMESITE_COOKIE } = require('../../../../src/appsec/iast/vulnerabilities')
const CookieAnalyzer = require('../../../../src/appsec/iast/analyzers/cookie-analyzer')
const noSamesiteCookieAnalyzer = require('../../../../src/appsec/iast/analyzers/no-samesite-cookie-analyzer')

describe('no SameSite cookie analyzer', () => {
  it('Expected vulnerability identifier', () => {
    expect(NO_SAMESITE_COOKIE).to.be.equals('NO_SAMESITE_COOKIE')
  })

  it('NoSamesiteCookieAnalyzer extends CookieAnalyzer', () => {
    expect(CookieAnalyzer.isPrototypeOf(noSamesiteCookieAnalyzer.constructor)).to.be.true
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
      }, NO_SAMESITE_COOKIE, 1, function (vulnerabilities) {
        expect(vulnerabilities[0].evidence.value).to.be.equals('key')
      })

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('set-cookie', ['key=value'])
      }, NO_SAMESITE_COOKIE, 1)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('set-cookie', ['key=value; SameSite=Lax'])
      }, NO_SAMESITE_COOKIE, 1)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('set-cookie', ['key=value; SameSite=None'])
      }, NO_SAMESITE_COOKIE, 1)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('set-cookie', ['key=value', 'key2=value2'])
      }, NO_SAMESITE_COOKIE, 1)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('set-cookie', ['key=value', 'key2=value2; Secure'])
      }, NO_SAMESITE_COOKIE, 1)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('set-cookie', ['key=value', 'key2=value2; SameSite=strict'])
      }, NO_SAMESITE_COOKIE, 1)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('set-cookie', ['key=value; SameSite=strict', 'key2=value2; Secure'])
      }, NO_SAMESITE_COOKIE, 1)

      testThatRequestHasNoVulnerability((req, res) => {
        res.setHeader('set-cookie', 'key=value; SameSite=strict')
      }, NO_SAMESITE_COOKIE)

      testThatRequestHasVulnerability((req, res) => {
        const cookieNamePrefix = '0'.repeat(32)
        res.setHeader('set-cookie', [cookieNamePrefix + 'key1=value', cookieNamePrefix + 'key2=value2'])
      }, NO_SAMESITE_COOKIE, 1, undefined, undefined,
      'Should be detected as the same NO_SAMESITE_COOKIE vulnerability when the cookie name is long')

      testThatRequestHasNoVulnerability((req, res) => {
        res.setHeader('set-cookie', 'key=')
      }, NO_SAMESITE_COOKIE)
    }, iastConfig)
})
