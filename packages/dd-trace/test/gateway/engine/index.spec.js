'use strict'

const Engine = require('../../../src/gateway/engine')
const { SubscriptionManager, Context } = require('../../../src/gateway/engine/engine')
const als = require('../../../src/gateway/als')

describe('Gateway Index', () => {
  afterEach((cb) => {
    sinon.restore()
    Engine.manager.clear()
    als.exit(cb)
  })

  it('should export a manager singleton and set it as context property', () => {
    expect(Engine.manager).to.be.an.instanceof(SubscriptionManager)
    expect(Context.manager).to.equal(Engine.manager)
  })

  describe('startContext', () => {
    it('should start a context and enter als and return the store', () => {
      const store = Engine.startContext()

      expect(store).to.be.an.instanceof(Map)
      expect(store.get('context')).to.be.an.instanceof(Context)
      expect(als.getStore()).to.equal(store)
    })
  })

  describe('getContext', () => {
    it('should return the current context', () => {
      const store = Engine.startContext()

      const context = Engine.getContext()

      expect(store.get('context')).to.equal(context)
    })

    it('should return nothing when there is no current context', () => {
      const context = Engine.getContext()

      expect(context).to.not.exist
    })
  })

  describe('propagate', () => {
    it('should not throw when there is no context', () => {
      expect(() => {
        Engine.propagate({ 'a': 1 }, null)
      }).to.not.throw()
    })

    it('should propagate values', () => {
      const store = Engine.startContext()
      const context = store.get('context')

      sinon.spy(context, 'setValue')
      sinon.spy(context, 'dispatch')

      Engine.manager.addresses.add('a')
      Engine.manager.addresses.add('b')

      Engine.propagate({ 'a': 1, 'b': 2 })

      expect(context.setValue).to.have.been.calledTwice
      expect(context.setValue.firstCall).to.have.been.calledWith('a', 1)
      expect(context.setValue.secondCall).to.have.been.calledWith('b', 2)
      expect(context.dispatch).to.have.been.calledOnce
    })

    it('should propagate to a passed context', () => {
      const context = new Context()

      sinon.spy(context, 'setValue')
      sinon.spy(context, 'dispatch')

      Engine.manager.addresses.add('a')
      Engine.manager.addresses.add('b')

      Engine.propagate({ 'a': 1, 'b': 2 }, context)

      expect(context.setValue).to.have.been.calledTwice
      expect(context.setValue.firstCall).to.have.been.calledWith('a', 1)
      expect(context.setValue.secondCall).to.have.been.calledWith('b', 2)
      expect(context.dispatch).to.have.been.calledOnce
    })

    it('should not propagate unneeded addresses', () => {
      const store = Engine.startContext()
      const context = store.get('context')

      sinon.spy(context, 'setValue')
      sinon.spy(context, 'dispatch')

      Engine.manager.addresses.add('b')

      Engine.propagate({ 'a': 1, 'b': 2 })

      expect(context.setValue).to.have.been.calledOnce
      expect(context.setValue.firstCall).to.have.been.calledWith('b', 2)
      expect(context.dispatch).to.have.been.calledOnce
    })
  })
})
