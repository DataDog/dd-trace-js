'use strict'

const proxyquire = require('proxyquire')
const Analyzer = require('../../../../src/appsec/iast/analyzers/vulnerability-analyzer')

describe('Analyzers index', () => {
  let analyzers
  let analyzerA
  let analyzerB
  let fakeAnalyzers

  beforeEach(() => {
    analyzerA = new Analyzer()
    analyzerB = new Analyzer()

    fakeAnalyzers = {
      analyzerA: analyzerA,
      analyzerB: analyzerB
    }

    Analyzer.prototype.configure = sinon.spy()

    analyzers = proxyquire('../../../../src/appsec/iast/analyzers', {
      './analyzers': fakeAnalyzers
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  it('should enable all analyzers', () => {
    analyzers.enableAllAnalyzers()
    expect(fakeAnalyzers.analyzerA.configure).to.have.been.calledWith(true)
    expect(fakeAnalyzers.analyzerB.configure).to.have.been.calledWith(true)
  })

  it('should disable all analyzers', () => {
    analyzers.disableAllAnalyzers()
    expect(fakeAnalyzers.analyzerA.configure).to.have.been.calledWith(false)
    expect(fakeAnalyzers.analyzerB.configure).to.have.been.calledWith(false)
  })
})
