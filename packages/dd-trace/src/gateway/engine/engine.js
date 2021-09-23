'use strict'

const { runSubscriptions } = require('./runner')

const MAX_CONTEXT_SIZE = 1024

class SubscriptionManager {
  constructor () {
    this.addressToSubscriptions = new Map()
    this.addresses = new Set()
    this.subscriptions = new Set()
  }

  clear () {
    this.addressToSubscriptions = new Map()
    this.addresses = new Set()
    this.subscriptions = new Set()
  }

  addSubscription (subscription) {
    if (!subscription.addresses.length || this.subscriptions.has(subscription)) return

    for (let i = 0; i < subscription.addresses.length; ++i) {
      const address = subscription.addresses[i]

      this.addresses.add(address)

      const list = this.addressToSubscriptions.get(address)

      if (list === undefined) {
        this.addressToSubscriptions.set(address, [ subscription ])
      } else {
        list.push(subscription)
      }
    }

    this.subscriptions.add(subscription)
  }

  matchSubscriptions (newAddresses, allAddresses) {
    const addresses = new Set()
    const subscriptions = new Set()
    const knowSubscriptions = new Set()

    // TODO: possible optimization: collect matchedSubscriptions on the fly in Context#setValue
    for (let i = 0; i < newAddresses.length; ++i) {
      const matchedSubscriptions = this.addressToSubscriptions.get(newAddresses[i])

      if (matchedSubscriptions === undefined) continue

      for (let j = 0; j < matchedSubscriptions.length; ++j) {
        const subscription = matchedSubscriptions[j]

        if (knowSubscriptions.has(subscription) === true) continue
        knowSubscriptions.add(subscription)

        const isFullfiled = subscription.addresses.every(allAddresses.has, allAddresses)

        if (isFullfiled === true) {
          for (let k = 0; k < subscription.addresses.length; ++k) {
            addresses.add(subscription.addresses[k])
          }

          subscriptions.add(subscription)
        }
      }
    }

    return { addresses, subscriptions }
  }

  dispatch (newAddresses, allAddresses, context) {
    const { addresses, subscriptions } = this.matchSubscriptions(newAddresses, allAddresses)

    const params = {}

    addresses.forEach((address) => {
      params[address] = context.resolve(address)
    })

    return runSubscriptions(subscriptions, params)
  }
}

class Context {
  static setManager (manager) {
    this.manager = manager
  }

  constructor () {
    this.store = new Map()
    this.allAddresses = new Set()
    this.newAddresses = []
  }

  cleanup () {
    this.store = new Map()
    this.allAddresses = new Set()
    this.newAddresses = []
  }

  setValue (address, value) {
    if (this.allAddresses.size >= MAX_CONTEXT_SIZE) return this

    const oldValue = this.store.get(address)
    if (oldValue === value) return this

    this.store.set(address, value)

    if (!this.newAddresses.includes(address)) {
      this.allAddresses.add(address)
      this.newAddresses.push(address)
    }

    return this
  }

  setMultipleValues (params) {
    const addresses = Object.keys(params)

    for (let i = 0; i < addresses.length; ++i) {
      const address = addresses[i]
      this.setValue(address, params[address])
    }

    return this
  }

  dispatch () {
    if (this.newAddresses.length === 0) return []

    const result = Context.manager.dispatch(this.newAddresses, this.allAddresses, this)

    this.newAddresses = []

    return result
  }

  resolve (address) {
    return this.store.get(address)
  }
}

module.exports = {
  SubscriptionManager,
  Context
}
