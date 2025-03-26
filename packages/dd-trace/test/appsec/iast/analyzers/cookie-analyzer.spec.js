'use strict'

const { assert } = require('chai')
const CookieAnalyzer = require('../../../../src/appsec/iast/analyzers/cookie-analyzer')
const Analyzer = require('../../../../src/appsec/iast/analyzers/vulnerability-analyzer')
const Config = require('../../../../src/config')

describe('CookieAnalyzer', () => {
  const VULNERABILITY_TYPE = 'VULN_TYPE'

  it('should extends Analyzer', () => {
    assert.isTrue(Analyzer.isPrototypeOf(CookieAnalyzer))
  })

  describe('_createHashSource', () => {
    let cookieAnalyzer

    beforeEach(() => {
      cookieAnalyzer = new CookieAnalyzer(VULNERABILITY_TYPE, 'prop')
    })

    describe('default config', () => {
      beforeEach(() => {
        cookieAnalyzer.onConfigure(new Config({ iast: true }))
      })

      it('should create hash from vulnerability type and not long enough evidence value', () => {
        const evidence = {
          value: '0'.repeat(31)
        }

        const vulnerability = cookieAnalyzer._createVulnerability(VULNERABILITY_TYPE, evidence, null, {})

        assert.equal(vulnerability.hash, cookieAnalyzer._createHash(`${VULNERABILITY_TYPE}:${evidence.value}`))
      })

      it('should create different hash from vulnerability type and long evidence value', () => {
        const evidence = {
          value: '0'.repeat(32)
        }

        const vulnerability = cookieAnalyzer._createVulnerability(VULNERABILITY_TYPE, evidence, null, {})

        assert.equal(vulnerability.hash, cookieAnalyzer._createHash(`FILTERED_${VULNERABILITY_TYPE}`))
      })
    })

    describe('custom cookieFilterPattern', () => {
      beforeEach(() => {
        cookieAnalyzer.onConfigure(new Config({
          iast: {
            enabled: true,
            cookieFilterPattern: '^filtered$'
          }
        }))
      })

      it('should create hash from vulnerability with the default pattern', () => {
        const evidence = {
          value: 'notfiltered'
        }

        const vulnerability = cookieAnalyzer._createVulnerability(VULNERABILITY_TYPE, evidence, null, {})

        assert.equal(vulnerability.hash, cookieAnalyzer._createHash(`${VULNERABILITY_TYPE}:${evidence.value}`))
      })

      it('should create different hash from vulnerability type and long evidence value', () => {
        const evidence = {
          value: 'filtered'
        }

        const vulnerability = cookieAnalyzer._createVulnerability(VULNERABILITY_TYPE, evidence, null, {})

        assert.equal(vulnerability.hash, cookieAnalyzer._createHash(`FILTERED_${VULNERABILITY_TYPE}`))
      })
    })

    describe('invalid cookieFilterPattern maintains default behaviour', () => {
      beforeEach(() => {
        cookieAnalyzer.onConfigure(new Config({
          iast: {
            enabled: true,
            cookieFilterPattern: '('
          }
        }))
      })

      it('should create hash from vulnerability type and not long enough evidence value', () => {
        const evidence = {
          value: '0'.repeat(31)
        }

        const vulnerability = cookieAnalyzer._createVulnerability(VULNERABILITY_TYPE, evidence, null, {})

        assert.equal(vulnerability.hash, cookieAnalyzer._createHash(`${VULNERABILITY_TYPE}:${evidence.value}`))
      })

      it('should create different hash from vulnerability type and long evidence value', () => {
        const evidence = {
          value: '0'.repeat(32)
        }

        const vulnerability = cookieAnalyzer._createVulnerability(VULNERABILITY_TYPE, evidence, null, {})

        assert.equal(vulnerability.hash, cookieAnalyzer._createHash(`FILTERED_${VULNERABILITY_TYPE}`))
      })
    })
  })
})
