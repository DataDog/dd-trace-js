'use strict'

const { expect } = require('chai')
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
    expect(fakeAnalyzers.analyzerA.configure).to.have.been.calledOnceWith({ enabled: true, tracerConfig })
    expect(fakeAnalyzers.analyzerB.configure).to.have.been.calledOnceWith({ enabled: true, tracerConfig })
  })

  it('should disable all analyzers', () => {
    analyzers.disableAllAnalyzers()
    expect(fakeAnalyzers.analyzerA.configure).to.have.been.calledOnceWith(false)
    expect(fakeAnalyzers.analyzerB.configure).to.have.been.calledOnceWith(false)
  })
})
