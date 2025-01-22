'use strict'

const { assert } = require('chai')
const proxyquire = require('proxyquire')
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
  let analyzer, ranges

  beforeEach(() => {
    ranges = []

    const InjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/injection-analyzer', {
      '../taint-tracking/operations': {
        getRanges: sinon.stub().callsFake(() => ranges)
      }
    })

    analyzer = new InjectionAnalyzer(SQL_INJECTION)
  })

  describe('_isVulnerable', () => {
    it('should return true if no secureMarks', () => {
      ranges = getRanges('tainted')
      assert.isTrue(analyzer._isVulnerable('tainted'))
    })

    it('should return true if secureMarks but no SQL_INJECTION_MARK', () => {
      ranges = getRanges('tainted', COMMAND_INJECTION_MARK)
      assert.isTrue(analyzer._isVulnerable('tainted'))
    })

    it('should return true if some range has secureMarks but no SQL_INJECTION_MARK', () => {
      ranges = [...getRanges('tainted', SQL_INJECTION), ...getRanges('tainted', COMMAND_INJECTION_MARK)]
      assert.isTrue(analyzer._isVulnerable('tainted'))
    })

    it('should return false if SQL_INJECTION_MARK', () => {
      ranges = getRanges('tainted', SQL_INJECTION_MARK)
      assert.isFalse(analyzer._isVulnerable('tainted'))
    })

    it('should return false if combined secureMarks with SQL_INJECTION_MARK', () => {
      ranges = getRanges('tainted', COMMAND_INJECTION_MARK | SQL_INJECTION_MARK)
      assert.isFalse(analyzer._isVulnerable('tained'))
    })

    describe('suppressed vulnerabilities metric', () => {
      const iastContext = {}

      it('should not increase metric', () => {
        const incrementSuppressedMetric = sinon.stub(analyzer, '_incrementSuppressedMetric')

        ranges = getRanges('tainted', COMMAND_INJECTION_MARK)
        analyzer._isVulnerable('tainted', iastContext)

        sinon.assert.notCalled(incrementSuppressedMetric)
      })

      it('should increase metric', () => {
        const incrementSuppressedMetric = sinon.stub(analyzer, '_incrementSuppressedMetric')

        ranges = getRanges('tainted', SQL_INJECTION_MARK)
        analyzer._isVulnerable('tainted', iastContext)

        sinon.assert.calledOnceWithExactly(incrementSuppressedMetric, iastContext)
      })
    })

    describe('with a range of SQL_ROW_VALUE input type', () => {
      it('should return false if SQL_ROW_VALUE type', () => {
        ranges = getRanges('tainted', undefined, SQL_ROW_VALUE)
        assert.isFalse(analyzer._isVulnerable('tainted'))
      })

      it('should return true if one different from SQL_ROW_VALUE type', () => {
        ranges = [...getRanges('tainted', undefined, SQL_ROW_VALUE), ...getRanges('tainted')]
        assert.isTrue(analyzer._isVulnerable(ranges))
      })
    })
  })
})
