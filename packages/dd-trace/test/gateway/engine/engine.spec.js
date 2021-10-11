'use strict'

const { SubscriptionManager, Context } = require('../../../src/gateway/engine/engine')

describe('Gateway Engine', () => {
  let manager

  beforeEach(() => {
    manager = new SubscriptionManager()
  })

  describe('Context', () => {
    let context

    beforeEach(() => {
      context = new Context()
      Context.setManager(manager)
    })

    describe('clear', () => {
      it('should reset the context', () => {
        context.setValue('address', 'value')

        context.clear()

        const result = context.resolve('address')

        expect(result).to.be.undefined
      })
    })

    describe('setValue', () => {
      it('should not do anything if MAX_CONTEXT_SIZE is reached', () => {
        const MAX_CONTEXT_SIZE = 1024
        let c = MAX_CONTEXT_SIZE - 1

        while (c--) {
          context.setValue(c, c)
        }

        expect(context.store.size).to.equal(MAX_CONTEXT_SIZE - 1)

        context.setValue('last_address', 'last_value')

        expect(context.store.size).to.equal(MAX_CONTEXT_SIZE)
        expect(context.store.get('last_address')).to.equal('last_value')

        const result = context.setValue('new_address', 'new_value')

        expect(result).to.equal(context)
        expect(context.store.size).to.equal(MAX_CONTEXT_SIZE)
        expect(context.store.get('new_address')).to.equal(undefined)
      })

      it('should not do anything if passed value is equal to existing address', () => {
        sinon.spy(context.store, 'set')

        context.setValue('address', 'value')

        expect(context.store.set).to.have.been.calledOnceWithExactly('address', 'value')

        const result = context.setValue('address', 'value')

        expect(result).to.equal(context)
        expect(context.store.set).to.have.been.calledOnce
      })

      it('should set a value', () => {
        const result = context.setValue('address', 'value')

        expect(result).to.equal(context)
        expect(context.store.get('address')).to.equal('value')
      })

      it('should not add the address in newAddresses twice', () => {
        context.setValue('address', 'value')

        expect(context.allAddresses).to.include('address')
        expect(context.newAddresses).to.deep.equal(['address'])

        const result = context.setValue('address', 'new_value')

        expect(result).to.equal(context)
        expect(context.store.get('address')).to.equal('new_value')

        expect(context.allAddresses).to.include('address')
        expect(context.newAddresses).to.deep.equal(['address'])
      })
    })

    describe('setMultipleValues', () => {
      it('should call setValue for every entry in passed object', () => {
        sinon.spy(context, 'setValue')

        const result = context.setMultipleValues({
          'a': 1,
          'b': 2,
          'c': 3
        })

        expect(result).to.equal(context)
        expect(context.setValue).to.have.been.calledThrice
        expect(context.setValue.firstCall).to.have.been.calledWithExactly('a', 1)
        expect(context.setValue.secondCall).to.have.been.calledWithExactly('b', 2)
        expect(context.setValue.thirdCall).to.have.been.calledWithExactly('c', 3)
      })
    })

    describe('dispatch', () => {
      it('should not call manager dispatch when there is no new addresses', () => {
        sinon.spy(Context.manager, 'dispatch')

        const result = context.dispatch()

        expect(result).to.deep.equal([])
        expect(Context.manager.dispatch).to.have.not.been.called
      })

      it('should call manager dispatch with new addresses', () => {
        sinon.stub(Context.manager, 'dispatch').returns('result')

        context.setValue('a', 1)

        const result = context.dispatch()

        expect(result).to.equal('result')

        expect(Context.manager.dispatch).to.have.been.calledOnceWithExactly(
          ['a'],
          new Set(['a']),
          context
        )

        context.setValue('b', 2)
        context.setValue('c', 3)

        context.dispatch()

        expect(Context.manager.dispatch).to.have.been.calledTwice
        expect(Context.manager.dispatch.secondCall).to.have.been.calledWithExactly(
          ['b', 'c'],
          new Set(['a', 'b', 'c']),
          context
        )
      })
    })

    describe('resolve', () => {
      it('should return the value for available address', () => {
        context.setValue('address', 'value')

        const result = context.resolve('address')

        expect(result).to.equal('value')
      })

      it('should return undefined for unavailable address', () => {
        const result = context.resolve('notfound')

        expect(result).to.be.undefined
      })
    })
  })
})
