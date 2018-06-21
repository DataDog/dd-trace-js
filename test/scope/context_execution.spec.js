'use strict'

describe('ContextExecution', () => {
  let ContextExecution
  let execution
  let context
  let scopes
  let children

  beforeEach(() => {
    context = {
      parent: sinon.stub(),
      retain: sinon.stub(),
      release: sinon.stub(),
      link: sinon.stub(),
      unlink: sinon.stub()
    }

    children = [1, 2, 3].map(() => ({
      parent: sinon.stub(),
      link: sinon.stub(),
      unlink: sinon.stub()
    }))

    scopes = [1, 2, 3].map(() => ({ close: sinon.stub() }))

    ContextExecution = require('../../src/scope/context_execution')

    execution = new ContextExecution(context)
  })

  it('should retain its context on initialization', () => {
    expect(context.retain).to.have.been.called
  })

  it('should close pending scopes on destroy with no children', () => {
    execution.retain()
    execution.add(scopes[0])
    execution.add(scopes[1])
    execution.release()

    expect(scopes[0].close).to.have.been.called
    expect(scopes[1].close).to.have.been.called
  })

  it('should not close pending scopes on exit with children', () => {
    execution.add(scopes[0])
    execution.attach(children[0])

    execution.exit()

    expect(scopes[0].close).to.not.have.been.called
  })

  it('should link children to its parent on exit when empty', () => {
    const parent = {}

    context.parent.returns(parent)

    execution.attach(children[0])
    execution.attach(children[1])

    execution.exit()

    expect(children[0].link).to.have.been.calledWith(parent)
    expect(children[1].link).to.have.been.calledWith(parent)
  })

  it('should not link children to its parent on exit when not empty', () => {
    const parent = {}

    context.parent.returns(parent)

    execution.attach(children[0])
    execution.add(scopes[0])

    execution.exit()

    expect(children[0].link).to.not.have.been.called
  })
})
