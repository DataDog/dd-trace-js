'use strict'

describe('Scope', () => {
  let Scope
  let scope
  let span
  let context

  beforeEach(() => {
    span = {
      finish: sinon.spy()
    }

    context = {
      remove: sinon.spy()
    }

    Scope = require('../../src/scope/scope')
  })

  it('should expose its span', () => {
    scope = new Scope(span, context)

    expect(scope.span()).to.equal(span)
  })

  it('should remove itself from the context on close', () => {
    scope = new Scope(span, context)

    scope.close()

    expect(context.remove).to.have.been.calledWith(scope)
  })

  it('should not finish the span on close by default', () => {
    scope = new Scope(span, context)

    scope.close()

    expect(span.finish).to.not.have.been.called
  })

  it('should support enabling to finish the span on close', () => {
    scope = new Scope(span, context, true)

    scope.close()

    expect(span.finish).to.have.been.called
  })
})
