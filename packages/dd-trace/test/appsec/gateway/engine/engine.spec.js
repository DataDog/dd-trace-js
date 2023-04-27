'use strict'

const { SubscriptionManager, Context } = require('../../../../src/appsec/gateway/engine/engine')
const Runner = require('../../../../src/appsec/gateway/engine/runner')

describe('Gateway Engine', () => {
  let manager

  beforeEach(() => {
    manager = new SubscriptionManager()
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('SubscriptionManager', () => {
    describe('clear', () => {
      it('should reset the manager', () => {
        manager.addSubscription({ addresses: ['a', 'b'] })

        manager.clear()

        expect(manager).to.deep.equal(new SubscriptionManager())
      })
    })

    describe('addSubscription', () => {
      it('should not do anything when passed no addresses', () => {
        manager.addSubscription({ addresses: [] })

        expect(manager.addresses).to.be.empty
      })

      it('should not do anything when passed a known subscription', () => {
        sinon.spy(manager.subscriptions, 'add')

        const subscription = { addresses: ['a', 'b', 'c'] }

        manager.addSubscription(subscription)

        expect(manager.subscriptions.add).to.have.been.calledOnce

        manager.addSubscription(subscription)

        expect(manager.subscriptions.add).to.have.been.calledOnce
      })

      it('should add subscription', () => {
        const subscription = { addresses: ['a', 'b', 'c'] }
        manager.addSubscription(subscription)

        expect(manager.addresses).to.have.all.keys('a', 'b', 'c')
        expect(manager.addressToSubscriptions.get('a')).to.include(subscription)
        expect(manager.addressToSubscriptions.get('b')).to.include(subscription)
        expect(manager.addressToSubscriptions.get('c')).to.include(subscription)
        expect(manager.subscriptions).to.include(subscription)
      })

      it('should add subscription when passed a known address', () => {
        const firstSub = { addresses: ['a', 'b'] }
        manager.addSubscription(firstSub)

        const secondSub = { addresses: ['b', 'c'] }
        manager.addSubscription(secondSub)

        expect(manager.addresses).to.have.all.keys('a', 'b', 'c')
        expect(manager.addressToSubscriptions.get('b')).to.have.members([firstSub, secondSub])
        expect(manager.subscriptions).to.have.all.keys(firstSub, secondSub)
      })
    })

    describe('matchSubscriptions', () => {
      it('should not match unknown newAddress', () => {
        const allAddresses = new Set(['unknown_newAddress'])
        sinon.spy(allAddresses, 'has')

        const result = manager.matchSubscriptions(new Set(['unknown_newAddress']), allAddresses)

        expect(result.addresses).to.be.empty
        expect(result.subscriptions).to.be.empty
        expect(allAddresses.has).to.not.have.been.called
      })

      it('should not match a subscription twice', () => {
        const subscription = { addresses: ['a', 'b'] }

        manager.addSubscription(subscription)

        const allAddresses = new Set(['a', 'b'])
        sinon.spy(allAddresses, 'has')

        const result = manager.matchSubscriptions(new Set(['a', 'b']), allAddresses)

        expect(result.subscriptions).to.have.all.keys(subscription)
        expect(allAddresses.has).to.have.been.calledTwice
        expect(allAddresses.has.firstCall).to.have.been.calledWith('a')
        expect(allAddresses.has.secondCall).to.have.been.calledWith('b')
      })

      it('should match subscriptions', () => {
        const firstSub = { addresses: ['a', 'b'] }
        manager.addSubscription(firstSub)

        const secondSub = { addresses: ['d'] }
        manager.addSubscription(secondSub)

        const thirdSub = { addresses: ['a', 'c'] }
        manager.addSubscription(thirdSub)

        const result = manager.matchSubscriptions(new Set(['a', 'c']), new Set(['a', 'b', 'c', 'd']))

        expect(result.addresses).to.have.all.keys('a', 'b', 'c')
        expect(result.subscriptions).to.have.all.keys(firstSub, thirdSub)
      })

      it('should not match unfulfilled subscription', () => {
        const firstSub = { addresses: ['a', 'b'] }
        manager.addSubscription(firstSub)

        const secondSub = { addresses: ['a', 'd'] }
        manager.addSubscription(secondSub)

        const thirdSub = { addresses: ['a', 'c'] }
        manager.addSubscription(thirdSub)

        const result = manager.matchSubscriptions(new Set(['a', 'c']), new Set(['a', 'b', 'c']))

        expect(result.addresses).to.have.all.keys('a', 'b', 'c')
        expect(result.subscriptions).to.have.all.keys(firstSub, thirdSub)
      })
    })

    describe('dispatch', () => {
      it('should call matchSubscriptions then call runSubscriptions with resolved params', () => {
        const context = new Context()
        context.setValue('a', 1)
        context.setValue('b', 2)
        context.setValue('c', 3)

        const addresses = new Set(['a', 'c'])

        const subscriptions = new Set([
          { addresses: ['a'] },
          { addresses: ['c'] }
        ])

        sinon.stub(manager, 'matchSubscriptions').returns({ addresses, subscriptions })
        sinon.stub(Runner, 'runSubscriptions').returns('result')

        const result = manager.dispatch(context.newAddresses, context.allAddresses, context)

        expect(result).to.equal('result')
        expect(manager.matchSubscriptions).to.have.been.calledOnceWithExactly(
          context.newAddresses,
          context.allAddresses
        )
        expect(Runner.runSubscriptions).to.have.been.calledOnceWithExactly(subscriptions, { a: 1, c: 3 })
      })
    })
  })

  describe('Context', () => {
    let oldManager
    let context

    before(() => {
      oldManager = Context.manager
    })

    beforeEach(() => {
      context = new Context()
      Context.setManager(manager)
    })

    // restore manager set in singleton
    after(() => {
      Context.setManager(oldManager)
    })

    describe('clear', () => {
      it('should reset the context', () => {
        context.setValue('address', 'value')

        context.clear()

        expect(context).to.deep.equal(new Context())
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

      it('should not check old value check when value is an object', () => {
        sinon.spy(context.store, 'set')

        const value = {}

        context.setValue('address', value)

        expect(context.store.set).to.have.been.calledOnceWithExactly('address', value)

        context.setValue('address', value)

        expect(context.store.set).to.have.been.calledTwice
        expect(context.store.set.secondCall).to.have.been.calledWithExactly('address', value)
      })

      it('should not add the address in newAddresses twice', () => {
        context.setValue('address', 'value')

        expect(context.allAddresses).to.deep.equal(new Set(['address']))
        expect(context.newAddresses).to.deep.equal(new Set(['address']))

        const result = context.setValue('address', 'new_value')

        expect(result).to.equal(context)
        expect(context.store.get('address')).to.equal('new_value')

        expect(context.allAddresses).to.deep.equal(new Set(['address']))
        expect(context.newAddresses).to.deep.equal(new Set(['address']))
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
        sinon.stub(context.newAddresses, 'clear')

        context.setValue('a', 1)

        const result = context.dispatch()

        expect(result).to.equal('result')

        expect(Context.manager.dispatch).to.have.been.calledOnceWithExactly(
          new Set(['a']),
          new Set(['a']),
          context
        )

        expect(context.newAddresses.clear).to.have.been.calledOnce
        context.newAddresses.clear.wrappedMethod.apply(context.newAddresses)

        context.setValue('b', 2)
        context.setValue('c', 3)

        context.dispatch()

        expect(Context.manager.dispatch).to.have.been.calledTwice
        expect(Context.manager.dispatch.secondCall).to.have.been.calledWithExactly(
          new Set(['b', 'c']),
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
