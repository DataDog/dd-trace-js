'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')
const constants = require('../../../../src/appsec/iast/taint-tracking/constants')
const dc = require('dc-polyfill')

describe('IAST Rewriter', () => {
  it('Addon should return a rewritter instance', () => {
    let rewriter = null
    expect(() => {
      rewriter = require('@datadog/native-iast-rewriter')
    }).to.not.throw(Error)
    expect(rewriter).to.not.be.null
  })

  describe('Enabling rewriter', () => {
    let rewriter, iastTelemetry, shimmer, Module, cacheRewrittenSourceMap, log, rewriterTelemetry

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

      Module = {
        register: sinon.stub()
      }

      cacheRewrittenSourceMap = sinon.stub()

      log = {
        error: sinon.stub()
      }

      const kSymbolPrepareStackTrace = Symbol('kTestSymbolPrepareStackTrace')
      rewriterTelemetry = {
        incrementTelemetryIfNeeded: sinon.stub()
      }

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
          kSymbolPrepareStackTrace,
          cacheRewrittenSourceMap
        },
        '../../../../../datadog-shimmer': shimmer,
        '../../telemetry': iastTelemetry,
        module: Module,
        '../../../log': log,
        './rewriter-telemetry': rewriterTelemetry
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

    describe('esm rewriter', () => {
      let originalNodeOptions, originalExecArgv

      beforeEach(() => {
        originalNodeOptions = process.env.NODE_OPTIONS
        originalExecArgv = process.execArgv
        process.env.NODE_OPTIONS = ''
        process.execArgv = []
      })

      afterEach(() => {
        process.env.NODE_OPTIONS = originalNodeOptions
        process.execArgv = originalExecArgv
        rewriter.disableRewriter()
      })

      it('Should not enable esm rewriter when ESM is not instrumented', () => {
        rewriter.enableRewriter()

        expect(Module.register).not.to.be.called
      })

      it('Should enable esm rewriter when ESM is configured with --loader exec arg', () => {
        process.execArgv = ['--loader', 'dd-trace/initialize.mjs']

        rewriter.enableRewriter()

        expect(Module.register).to.be.calledOnce
      })

      it('Should enable esm rewriter when ESM is configured with --experimental-loader exec arg', () => {
        process.execArgv = ['--experimental-loader', 'dd-trace/initialize.mjs']

        rewriter.enableRewriter()

        expect(Module.register).to.be.calledOnce
      })

      it('Should enable esm rewriter when ESM is configured with --loader in NODE_OPTIONS', () => {
        process.env.NODE_OPTIONS = '--loader dd-trace/initialize.mjs'

        rewriter.enableRewriter()

        expect(Module.register).to.be.calledOnce
      })

      it('Should enable esm rewriter when ESM is configured with --experimental-loader in NODE_OPTIONS', () => {
        process.env.NODE_OPTIONS = '--experimental-loader dd-trace/initialize.mjs'

        rewriter.enableRewriter()

        expect(Module.register).to.be.calledOnce
      })

      describe('thread communication', () => {
        let port

        beforeEach(() => {
          process.execArgv = ['--loader', 'dd-trace/initialize.mjs']
          rewriter.enableRewriter()
          port = Module.register.args[0][1].data.port
        })

        it('should cache sourceMaps when metrics status is modified', (done) => {
          const content = 'file-content'
          const data = {
            rewritten: {
              metrics: { status: 'modified' },
              content
            },
            url: 'file://file.js'
          }

          port.postMessage({ type: constants.REWRITTEN, data })

          setTimeout(() => {
            expect(cacheRewrittenSourceMap).to.be.calledOnceWith('file.js', content)

            done()
          })
        })

        it('should call to increment telemetry', (done) => {
          const content = 'file-content'
          const metrics = { status: 'modified' }
          const data = {
            rewritten: {
              metrics,
              content
            },
            url: 'file://file.js'
          }

          port.postMessage({ type: constants.REWRITTEN, data })

          setTimeout(() => {
            expect(rewriterTelemetry.incrementTelemetryIfNeeded).to.be.calledOnceWith(metrics)

            done()
          })
        })

        it('should publish hardcoded secrets channel with literals', (done) => {
          const content = 'file-content'
          const metrics = { status: 'modified' }
          const literalsResult = ['literal1', 'literal2']
          const data = {
            rewritten: {
              metrics,
              content,
              literalsResult
            },
            url: 'file://file.js'
          }
          const hardcodedSecretCh = dc.channel('datadog:secrets:result')

          function onHardcodedSecret (literals) {
            expect(literals).to.deep.equal(literalsResult)

            done()
          }

          hardcodedSecretCh.subscribe(onHardcodedSecret)

          port.postMessage({ type: constants.REWRITTEN, data })

          setTimeout(() => {
            hardcodedSecretCh.unsubscribe(onHardcodedSecret)
          })
        })

        it('should log the message', (done) => {
          const messages = ['this is a %s', 'test']
          const data = {
            level: 'error',
            messages
          }

          port.postMessage({ type: constants.LOG, data })

          setTimeout(() => {
            expect(log.error).to.be.calledOnceWith(...messages)

            done()
          })
        })
      })
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
