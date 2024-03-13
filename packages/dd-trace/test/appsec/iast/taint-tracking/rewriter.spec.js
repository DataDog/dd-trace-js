'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')

describe('IAST Rewriter', () => {
  it('Addon should return a rewritter instance', () => {
    let rewriter = null
    expect(() => {
      rewriter = require('@datadog/native-iast-rewriter')
    }).to.not.throw(Error)
    expect(rewriter).to.not.be.null
  })

  describe('Enabling rewriter', () => {
    let rewriter, iastTelemetry, shimmer

    class Rewriter {
      rewrite (content, filename) {
        return {
          content: content + 'rewritten',
          metrics: {
            instrumentedPropagation: 2
          }
        }
      }
    }

    beforeEach(() => {
      iastTelemetry = {
        add: sinon.spy()
      }

      shimmer = {
        wrap: sinon.spy(),
        unwrap: sinon.spy()
      }

      const kSymbolPrepareStackTrace = Symbol('kTestSymbolPrepareStackTrace')

      rewriter = proxyquire('../../../../src/appsec/iast/taint-tracking/rewriter', {
        '@datadog/native-iast-rewriter': {
          Rewriter,
          getPrepareStackTrace: function (fn) {
            const testWrap = function testWrappedPrepareStackTrace (_, callsites) {
              return fn(_, callsites)
            }
            Object.defineProperty(testWrap, kSymbolPrepareStackTrace, {
              value: true
            })
            return testWrap
          },
          kSymbolPrepareStackTrace
        },
        '../../../../../datadog-shimmer': shimmer,
        '../../telemetry': iastTelemetry
      })
    })

    afterEach(() => {
      sinon.reset()
    })

    it('Should wrap module compile method on taint tracking enable', () => {
      rewriter.enableRewriter()
      expect(shimmer.wrap).to.be.calledOnce
      expect(shimmer.wrap.getCall(0).args[1]).eq('_compile')

      rewriter.disableRewriter()
    })

    it('Should unwrap module compile method on taint tracking disable', () => {
      rewriter.disableRewriter()

      expect(shimmer.unwrap).to.be.calledOnce
      expect(shimmer.unwrap.getCall(0).args[1]).eq('_compile')
    })

    it('Should keep original prepareStackTrace fn when calling enable and then disable', () => {
      const orig = Error.prepareStackTrace

      rewriter.enableRewriter()

      const testPrepareStackTrace = (_, callsites) => {
        // do nothing
      }
      Error.prepareStackTrace = testPrepareStackTrace

      rewriter.disableRewriter()

      expect(Error.prepareStackTrace).to.be.eq(testPrepareStackTrace)

      Error.prepareStackTrace = orig
    })

    it('Should keep original prepareStackTrace fn when calling disable only', () => {
      const orig = Error.prepareStackTrace

      const testPrepareStackTrace = (_, callsites) => {
        // do nothing
      }
      Error.prepareStackTrace = testPrepareStackTrace

      rewriter.disableRewriter()

      expect(Error.prepareStackTrace).to.be.eq(testPrepareStackTrace)

      Error.prepareStackTrace = orig
    })

    it('Should keep original prepareStackTrace fn when calling disable if not marked with the Symbol', () => {
      const orig = Error.prepareStackTrace

      rewriter.enableRewriter()

      // remove iast property to avoid wrapping the new testPrepareStackTrace fn
      delete Error.prepareStackTrace

      const testPrepareStackTrace = (_, callsites) => {
        // do nothing
      }
      Error.prepareStackTrace = testPrepareStackTrace

      rewriter.disableRewriter()

      expect(Error.prepareStackTrace).to.be.eq(testPrepareStackTrace)

      Error.prepareStackTrace = orig
    })
  })

  describe('getOriginalPathAndLineFromSourceMap', () => {
    let rewriter, getOriginalPathAndLineFromSourceMap, argvs
    beforeEach(() => {
      getOriginalPathAndLineFromSourceMap = sinon.spy()
      rewriter = proxyquire('../../../../src/appsec/iast/taint-tracking/rewriter', {
        '@datadog/native-iast-rewriter': {
          getOriginalPathAndLineFromSourceMap
        }
      })
      argvs = [...process.execArgv].filter(arg => arg !== '--enable-source-maps')
    })

    afterEach(() => {
      sinon.restore()
      rewriter.disableRewriter()
    })

    it('should call native getOriginalPathAndLineFromSourceMap if --enable-source-maps is not present', () => {
      sinon.stub(process, 'execArgv').value(argvs)

      rewriter.enableRewriter()

      const location = { path: 'test', line: 42, column: 4 }
      rewriter.getOriginalPathAndLineFromSourceMap(location)

      expect(getOriginalPathAndLineFromSourceMap).to.be.calledOnceWithExactly('test', 42, 4)
    })

    it('should not call native getOriginalPathAndLineFromSourceMap if --enable-source-maps is present', () => {
      sinon.stub(process, 'execArgv').value([...argvs, '--enable-source-maps'])

      rewriter.enableRewriter()

      const location = { path: 'test', line: 42, column: 4 }
      rewriter.getOriginalPathAndLineFromSourceMap(location)

      expect(getOriginalPathAndLineFromSourceMap).to.not.be.called
    })

    it('should not call native getOriginalPathAndLineFromSourceMap if --enable-source-maps as NODE_OPTION', () => {
      sinon.stub(process, 'execArgv').value(argvs)

      const origNodeOptions = process.env.NODE_OPTIONS

      process.env.NODE_OPTIONS = process.env.NODE_OPTIONS
        ? process.env.NODE_OPTIONS + ' --enable-source-maps'
        : '--enable-source-maps'

      rewriter.enableRewriter()

      const location = { path: 'test', line: 42, column: 4 }
      rewriter.getOriginalPathAndLineFromSourceMap(location)

      expect(getOriginalPathAndLineFromSourceMap).to.not.be.called

      process.env.NODE_OPTIONS = origNodeOptions
    })
  })
})
