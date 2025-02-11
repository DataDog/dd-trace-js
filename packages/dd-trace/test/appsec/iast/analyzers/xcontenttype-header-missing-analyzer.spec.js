'use strict'

const { prepareTestServerForIast } = require('../utils')
const Analyzer = require('../../../../src/appsec/iast/analyzers/vulnerability-analyzer')
const { XCONTENTTYPE_HEADER_MISSING } = require('../../../../src/appsec/iast/vulnerabilities')
const analyzer = new Analyzer()

describe('xcontenttype header missing analyzer', () => {
  it('Expected vulnerability identifier', () => {
    expect(XCONTENTTYPE_HEADER_MISSING).to.be.equals('XCONTENTTYPE_HEADER_MISSING')
  })

  prepareTestServerForIast('xcontenttype header missing analyzer',
    (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('content-type', 'text/html')
        res.end('<html><body><h1>Test</h1></body></html>')
      }, XCONTENTTYPE_HEADER_MISSING, 1, function (vulnerabilities) {
        expect(vulnerabilities[0].evidence).to.be.undefined
        expect(vulnerabilities[0].hash).to.be.equals(analyzer._createHash('XCONTENTTYPE_HEADER_MISSING:mocha'))
      }, undefined, undefined, false)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('content-type', 'text/html;charset=utf-8')
        res.end('<html><body><h1>Test</h1></body></html>')
      }, XCONTENTTYPE_HEADER_MISSING, 1, function (vulnerabilities) {
        expect(vulnerabilities[0].evidence).to.be.undefined
        expect(vulnerabilities[0].hash).to.be.equals(analyzer._createHash('XCONTENTTYPE_HEADER_MISSING:mocha'))
      }, undefined, undefined, false)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('content-type', 'application/xhtml+xml')
        res.end('<html><body><h1>Test</h1></body></html>')
      }, XCONTENTTYPE_HEADER_MISSING, 1, function (vulnerabilities) {
        expect(vulnerabilities[0].evidence).to.be.undefined
        expect(vulnerabilities[0].hash).to.be.equals(analyzer._createHash('XCONTENTTYPE_HEADER_MISSING:mocha'))
      }, undefined, undefined, false)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('content-type', 'text/html')
        res.setHeader('X-Content-Type-Options', 'whatever')
        res.end('<html><body><h1>Test</h1></body></html>')
      }, XCONTENTTYPE_HEADER_MISSING, 1, function (vulnerabilities) {
        expect(vulnerabilities[0].evidence.value).to.be.equal('whatever')
        expect(vulnerabilities[0].hash).to.be.equals(analyzer._createHash('XCONTENTTYPE_HEADER_MISSING:mocha'))
      }, undefined, undefined, false)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('content-type', ['text/html'])
        res.setHeader('X-Content-Type-Options', 'whatever')
        res.end('<html><body><h1>Test</h1></body></html>')
      }, XCONTENTTYPE_HEADER_MISSING, 1, function (vulnerabilities) {
        expect(vulnerabilities[0].evidence.value).to.be.equal('whatever')
        expect(vulnerabilities[0].hash).to.be.equals(analyzer._createHash('XCONTENTTYPE_HEADER_MISSING:mocha'))
      }, undefined, undefined, false)

      testThatRequestHasNoVulnerability((req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end('{"key": "test}')
      }, XCONTENTTYPE_HEADER_MISSING)

      testThatRequestHasNoVulnerability((req, res) => {
        res.setHeader('content-type', 'text/html')
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.end('{"key": "test}')
      }, XCONTENTTYPE_HEADER_MISSING)

      testThatRequestHasNoVulnerability((req, res) => {
        res.setHeader('content-type', ['text/html'])
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.end('{"key": "test}')
      }, XCONTENTTYPE_HEADER_MISSING)
    })
})
