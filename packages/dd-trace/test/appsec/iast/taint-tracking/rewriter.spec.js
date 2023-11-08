'use strict'
const path = require('path')
const os = require('os')
const fs = require('fs')
const { pathToFileURL } = require('node:url')
const { expect } = require('chai')
const dc = require('dc-polyfill')
const proxyquire = require('proxyquire')
const semver = require('semver')
const iast = require('../../../../src/appsec/iast')
const Config = require('../../../../src/config')

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
        add: sinon.stub()
      }
      shimmer = {
        wrap: sinon.stub(),
        unwrap: sinon.stub()
      }
      rewriter = proxyquire('../../../../src/appsec/iast/taint-tracking/rewriter', {
        '@datadog/native-iast-rewriter': { Rewriter, getPrepareStackTrace: function () {} },
        '../../../../../datadog-shimmer': shimmer,
        '../../telemetry': iastTelemetry
      })
    })

    afterEach(() => {
      rewriter.disableRewriter()
    })

    it('Should wrap module compile method on taint tracking enable', () => {
      rewriter.enableRewriter()
      expect(shimmer.wrap).to.be.calledOnce
      expect(shimmer.wrap.getCall(0).args[1]).eq('_compile')
    })

    it('Should unwrap module compile method on taint tracking disable', () => {
      rewriter.disableRewriter()
      expect(shimmer.unwrap).to.be.calledOnce
      expect(shimmer.unwrap.getCall(0).args[1]).eq('_compile')
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

  describe('ESM rewriter hooks', () => {
    const sourcePreloadChannel = dc.channel('iitm:source:preload')

    beforeEach(() => {
      iast.enable(new Config({
        experimental: {
          iast: {
            enabled: true
          }
        }
      }))
    })

    it('should rewrite in channel object data', () => {
      const source = Buffer.from(`export function test(b,c) { return  b + c }`)
      const preloadData = {
        source,
        url: pathToFileURL(path.join(os.tmpdir(), 'test1.mjs')).toString()
      }

      sourcePreloadChannel.publish(preloadData)

      expect(preloadData.source.toString()).to.contain('_ddiast.plusOperator(')
    })

    if (semver.satisfies(process.versions.node, '>=20.6.0')) {
      it('should publish events when module is imported', (done) => {
        const esmOneJsFilePath = path.join(os.tmpdir(), 'esm-one.mjs')
        const esmTwoJsFilePath = path.join(os.tmpdir(), 'esm-two.mjs')
        fs.copyFileSync(path.join(__dirname, 'resources', 'esm-one.mjs'), esmOneJsFilePath)
        fs.copyFileSync(path.join(__dirname, 'resources', 'esm-two.mjs'), esmTwoJsFilePath)

        const channelCallback = sinon.stub()
        sourcePreloadChannel.subscribe(channelCallback)

        import(esmOneJsFilePath).then(() => {
          expect(channelCallback).to.have.been.calledTwice
          expect(channelCallback.firstCall.args[0].url).to.contain('esm-one.mjs')
          expect(channelCallback.secondCall.args[0].url).to.contain('esm-two.mjs')

          sourcePreloadChannel.unsubscribe(channelCallback)
          done()
        }).catch(done)
      })
    }

    afterEach(() => {
      iast.disable()
    })
  })
})
