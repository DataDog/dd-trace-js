'use strict'

const { prepareTestServerForIast } = require('../utils')
const Analyzer = require('../../../../src/appsec/iast/analyzers/vulnerability-analyzer')
const { INSECURE_COOKIE } = require('../../../../src/appsec/iast/vulnerabilities')
const analyzer = new Analyzer()

describe('insecure cookie analyzer', () => {
  it('Expected vulnerability identifier', () => {
    expect(INSECURE_COOKIE).to.be.equals('INSECURE_COOKIE')
  })

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

      testThatRequestHasNoVulnerability((req, res) => {
        res.setHeader('set-cookie', 'key=value; Secure')
      }, INSECURE_COOKIE)

      testThatRequestHasNoVulnerability((req, res) => {
        res.setHeader('set-cookie', 'key=')
      }, INSECURE_COOKIE)
    })
})
