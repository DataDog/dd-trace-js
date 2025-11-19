'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const CookieAnalyzer = require('../../../../src/appsec/iast/analyzers/cookie-analyzer')
const insecureCookieAnalyzer = require('../../../../src/appsec/iast/analyzers/insecure-cookie-analyzer')
const { INSECURE_COOKIE } = require('../../../../src/appsec/iast/vulnerabilities')
const { prepareTestServerForIast } = require('../utils')
describe('insecure cookie analyzer', () => {
  it('Expected vulnerability identifier', () => {
    assert.strictEqual(INSECURE_COOKIE, 'INSECURE_COOKIE')
  })

  it('InsecureCookieAnalyzer extends CookieAnalyzer', () => {
    assert.strictEqual(CookieAnalyzer.isPrototypeOf(insecureCookieAnalyzer.constructor), true)
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
        assert.strictEqual(vulnerabilities[0].evidence.value, 'key')
      })

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('set-cookie', ['key=value'])
      }, INSECURE_COOKIE, 1)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('set-cookie', ['key=value', 'key2=value2'])
      }, INSECURE_COOKIE, 1)
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
