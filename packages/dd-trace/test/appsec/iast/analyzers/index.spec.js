'use strict'
const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('Analyzers index', () => {
  let fakeAnalyzers
  let analyzers

  beforeEach(() => {
    fakeAnalyzers = {
      analyzerA: {
        configure: sinon.spy()
      },
      analyzerB: {
        configure: sinon.spy()
      }
    }
    analyzers = proxyquire.noCallThru()('../../../../src/appsec/iast/analyzers', {
      './analyzers': fakeAnalyzers
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  it('should enable all analyzers', () => {
    const tracerConfig = {}
    analyzers.enableAllAnalyzers(tracerConfig)
    sinon.assert.calledOnceWith(fakeAnalyzers.analyzerA.configure, { enabled: true, tracerConfig })
    sinon.assert.calledOnceWith(fakeAnalyzers.analyzerB.configure, { enabled: true, tracerConfig })
  })

  it('should disable all analyzers', () => {
    analyzers.disableAllAnalyzers()
    sinon.assert.calledOnceWith(fakeAnalyzers.analyzerA.configure, false)
    sinon.assert.calledOnceWith(fakeAnalyzers.analyzerB.configure, false)
  })
})
