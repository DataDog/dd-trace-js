'use strict'

const { expect } = require('chai')
const { describe, it } = require('mocha')

const { prepareTestServerForIast } = require('../utils')
const Analyzer = require('../../../../src/appsec/iast/analyzers/vulnerability-analyzer')
const { HSTS_HEADER_MISSING } = require('../../../../src/appsec/iast/vulnerabilities')
const axios = require('axios')
const analyzer = new Analyzer()

describe('hsts header missing analyzer', () => {
  it('Expected vulnerability identifier', () => {
    expect(HSTS_HEADER_MISSING).to.be.equals('HSTS_HEADER_MISSING')
  })

  prepareTestServerForIast('hsts header missing analyzer',
    (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability, config) => {
      function makeRequestWithXFordwardedProtoHeader (done) {
        axios.get(`http://localhost:${config.port}/`, {
          headers: {
            'X-Forwarded-Proto': 'https'
          }
        }).catch(done)
      }

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('content-type', 'text/html')
        res.end('<html><body><h1>Test</h1></body></html>')
      }, HSTS_HEADER_MISSING, 1, function (vulnerabilities) {
        expect(vulnerabilities[0].evidence).to.be.undefined
        expect(vulnerabilities[0].hash).to.be.equals(analyzer._createHash('HSTS_HEADER_MISSING:mocha'))
      }, makeRequestWithXFordwardedProtoHeader, undefined, false)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('content-type', 'text/html;charset=utf-8')
        res.end('<html><body><h1>Test</h1></body></html>')
      }, HSTS_HEADER_MISSING, 1, function (vulnerabilities) {
        expect(vulnerabilities[0].evidence).to.be.undefined
        expect(vulnerabilities[0].hash).to.be.equals(analyzer._createHash('HSTS_HEADER_MISSING:mocha'))
      }, makeRequestWithXFordwardedProtoHeader, undefined, false)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('content-type', 'application/xhtml+xml')
        res.end('<html><body><h1>Test</h1></body></html>')
      }, HSTS_HEADER_MISSING, 1, function (vulnerabilities) {
        expect(vulnerabilities[0].evidence).to.be.undefined
        expect(vulnerabilities[0].hash).to.be.equals(analyzer._createHash('HSTS_HEADER_MISSING:mocha'))
      }, makeRequestWithXFordwardedProtoHeader, undefined, false)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('content-type', 'text/html')
        res.setHeader('Strict-Transport-Security', 'max-age=-100')
        res.end('<html><body><h1>Test</h1></body></html>')
      }, HSTS_HEADER_MISSING, 1, function (vulnerabilities) {
        expect(vulnerabilities[0].evidence.value).to.be.equal('max-age=-100')
        expect(vulnerabilities[0].hash).to.be.equals(analyzer._createHash('HSTS_HEADER_MISSING:mocha'))
      }, makeRequestWithXFordwardedProtoHeader, undefined, false)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('content-type', 'text/html')
        res.setHeader('Strict-Transport-Security', 'max-age=-100; includeSubDomains')
        res.end('<html><body><h1>Test</h1></body></html>')
      }, HSTS_HEADER_MISSING, 1, function (vulnerabilities) {
        expect(vulnerabilities[0].evidence.value).to.be.equal('max-age=-100; includeSubDomains')
        expect(vulnerabilities[0].hash).to.be.equals(analyzer._createHash('HSTS_HEADER_MISSING:mocha'))
      }, makeRequestWithXFordwardedProtoHeader, undefined, false)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('content-type', 'text/html')
        res.setHeader('Strict-Transport-Security', 'invalid')
        res.end('<html><body><h1>Test</h1></body></html>')
      }, HSTS_HEADER_MISSING, 1, function (vulnerabilities) {
        expect(vulnerabilities[0].evidence.value).to.be.equal('invalid')
        expect(vulnerabilities[0].hash).to.be.equals(analyzer._createHash('HSTS_HEADER_MISSING:mocha'))
      }, makeRequestWithXFordwardedProtoHeader, undefined, false)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('content-type', ['text/html'])
        res.setHeader('Strict-Transport-Security', 'invalid')
        res.end('<html><body><h1>Test</h1></body></html>')
      }, HSTS_HEADER_MISSING, 1, function (vulnerabilities) {
        expect(vulnerabilities[0].evidence.value).to.be.equal('invalid')
        expect(vulnerabilities[0].hash).to.be.equals(analyzer._createHash('HSTS_HEADER_MISSING:mocha'))
      }, makeRequestWithXFordwardedProtoHeader, undefined, false)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('content-type', ['text/html'])
        res.setHeader('Strict-Transport-Security', [])
        res.end('<html><body><h1>Test</h1></body></html>')
      }, HSTS_HEADER_MISSING, 1, function (vulnerabilities) {
        expect(vulnerabilities[0].evidence).to.be.undefined
        expect(vulnerabilities[0].hash).to.be.equals(analyzer._createHash('HSTS_HEADER_MISSING:mocha'))
      }, makeRequestWithXFordwardedProtoHeader, undefined, false)

      testThatRequestHasVulnerability((req, res) => {
        res.setHeader('content-type', ['text/html'])
        res.setHeader('Strict-Transport-Security', ['invalid1', 'invalid2'])
        res.end('<html><body><h1>Test</h1></body></html>')
      }, HSTS_HEADER_MISSING, 1, function (vulnerabilities) {
        expect(vulnerabilities[0].evidence.value).to.be.equal(JSON.stringify(['invalid1', 'invalid2']))
        expect(vulnerabilities[0].hash).to.be.equals(analyzer._createHash('HSTS_HEADER_MISSING:mocha'))
      }, makeRequestWithXFordwardedProtoHeader, undefined, false)

      testThatRequestHasNoVulnerability((req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end('{"key": "test}')
      }, HSTS_HEADER_MISSING, makeRequestWithXFordwardedProtoHeader)

      testThatRequestHasNoVulnerability((req, res) => {
        res.setHeader('content-type', ['application/json'])
        res.end('{"key": "test}')
      }, HSTS_HEADER_MISSING, makeRequestWithXFordwardedProtoHeader)

      testThatRequestHasNoVulnerability((req, res) => {
        res.setHeader('content-type', 'text/html')
        res.setHeader('Strict-Transport-Security', 'max-age=100')
        res.end('{"key": "test}')
      }, HSTS_HEADER_MISSING, makeRequestWithXFordwardedProtoHeader)

      testThatRequestHasNoVulnerability((req, res) => {
        res.setHeader('content-type', 'text/html')
        res.setHeader('Strict-Transport-Security', '  max-age=100  ')
        res.end('{"key": "test}')
      }, HSTS_HEADER_MISSING, makeRequestWithXFordwardedProtoHeader)

      testThatRequestHasNoVulnerability((req, res) => {
        res.setHeader('content-type', 'text/html')
        res.setHeader('Strict-Transport-Security', 'max-age=100;includeSubDomains')
        res.end('{"key": "test}')
      }, HSTS_HEADER_MISSING, makeRequestWithXFordwardedProtoHeader)

      testThatRequestHasNoVulnerability((req, res) => {
        res.setHeader('content-type', 'text/html')
        res.setHeader('Strict-Transport-Security', 'max-age=100   ;includeSubDomains')
        res.end('{"key": "test}')
      }, HSTS_HEADER_MISSING, makeRequestWithXFordwardedProtoHeader)
    })
})
