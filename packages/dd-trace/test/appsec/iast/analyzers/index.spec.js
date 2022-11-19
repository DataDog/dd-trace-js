'use strict'

require('../../../setup/core')

const proxyquire = require('proxyquire')

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
    analyzers.enableAllAnalyzers()
    expect(fakeAnalyzers.analyzerA.configure).to.have.been.calledOnceWith(true)
    expect(fakeAnalyzers.analyzerB.configure).to.have.been.calledOnceWith(true)
  })

  it('should disable all analyzers', () => {
    analyzers.disableAllAnalyzers()
    expect(fakeAnalyzers.analyzerA.configure).to.have.been.calledOnceWith(false)
    expect(fakeAnalyzers.analyzerB.configure).to.have.been.calledOnceWith(false)
  })
})
