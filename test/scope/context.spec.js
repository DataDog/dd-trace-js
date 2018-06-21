'use strict'

describe('Context', () => {
  let Context
  let context
  let parent
  let ancestor

  beforeEach(() => {
    Context = require('../../src/scope/context')

    parent = { attach: sinon.stub(), detach: sinon.stub() }
    ancestor = { attach: sinon.stub(), detach: sinon.stub() }
    context = new Context()
  })

  it('should switch parent when linked', () => {
    context.link(parent)

    expect(context.parent()).to.equal(parent)
  })

  it('should attach to the parent when linked', () => {
    context.link(parent)

    expect(parent.attach).to.have.been.calledWith(context)
  })

  it('should remove its parent when unlinked', () => {
    context.link(parent)
    context.unlink()

    expect(context.parent()).to.be.null
  })

  it('should detach from the parent when unlinked', () => {
    context.link(parent)
    context.unlink()

    expect(parent.detach).to.have.been.calledWith(context)
  })

  it('should attach to the new parent when relinked', () => {
    context.link(parent)
    context.link(ancestor)

    expect(parent.detach).to.have.been.calledWith(context)
    expect(ancestor.attach).to.have.been.calledWith(context)
    expect(context.parent()).to.equal(ancestor)
  })

  it('should unlink from its parent when no longer retained', () => {
    context.link(parent)
    context.retain()
    context.release()

    expect(parent.detach).to.have.been.calledWith(context)
  })
})
