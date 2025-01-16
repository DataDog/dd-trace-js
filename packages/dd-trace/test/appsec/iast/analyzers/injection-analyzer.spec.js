'use strict'

const { assert } = require('chai')
const InjectionAnalyzer = require('../../../../src/appsec/iast/analyzers/injection-analyzer')
const { HTTP_REQUEST_PARAMETER, SQL_ROW_VALUE } = require('../../../../src/appsec/iast/taint-tracking/source-types')
const { SQL_INJECTION } = require('../../../../src/appsec/iast/vulnerabilities')
const { COMMAND_INJECTION_MARK, SQL_INJECTION_MARK } =
  require('../../../../src/appsec/iast/taint-tracking/secure-marks')

function getRanges (string, secureMarks, type = HTTP_REQUEST_PARAMETER) {
  const range = {
    start: 0,
    end: string.length,
    iinfo: {
      parameterName: 'param',
      parameterValue: string,
      type
    },
    secureMarks
  }

  return [range]
}

describe('InjectionAnalyzer', () => {
  describe('_areRangesVulnerable', () => {
    it('should return true if no secureMarks', () => {
      const analyzer = new InjectionAnalyzer(SQL_INJECTION)

      assert.isTrue(analyzer._areRangesVulnerable(getRanges('tainted')))
    })

    it('should return true if secureMarks but no SQL_INJECTION_MARK', () => {
      const analyzer = new InjectionAnalyzer(SQL_INJECTION)

      assert.isTrue(analyzer._areRangesVulnerable(getRanges('tainted', COMMAND_INJECTION_MARK)))
    })

    it('should return true if some range has secureMarks but no SQL_INJECTION_MARK', () => {
      const analyzer = new InjectionAnalyzer(SQL_INJECTION)

      const ranges = [...getRanges('tainted', SQL_INJECTION), ...getRanges('tainted', COMMAND_INJECTION_MARK)]
      assert.isTrue(analyzer._areRangesVulnerable(ranges))
    })

    it('should return false if SQL_INJECTION_MARK', () => {
      const analyzer = new InjectionAnalyzer(SQL_INJECTION)

      assert.isFalse(analyzer._areRangesVulnerable(getRanges('tainted', SQL_INJECTION_MARK)))
    })

    it('should return false if combined secureMarks with SQL_INJECTION_MARK', () => {
      const analyzer = new InjectionAnalyzer(SQL_INJECTION)

      assert.isFalse(analyzer._areRangesVulnerable(getRanges('tainted', COMMAND_INJECTION_MARK | SQL_INJECTION_MARK)))
    })

    describe('with a range of SQL_ROW_VALUE input type', () => {
      it('should return false if SQL_ROW_VALUE type', () => {
        const analyzer = new InjectionAnalyzer(SQL_INJECTION)

        assert.isFalse(analyzer._areRangesVulnerable(getRanges('tainted', undefined, SQL_ROW_VALUE)))
      })

      it('should return true if one different from SQL_ROW_VALUE type', () => {
        const analyzer = new InjectionAnalyzer(SQL_INJECTION)

        const ranges = [...getRanges('tainted', undefined, SQL_ROW_VALUE), ...getRanges('tainted')]
        assert.isTrue(analyzer._areRangesVulnerable(ranges))
      })
    })
  })
})
