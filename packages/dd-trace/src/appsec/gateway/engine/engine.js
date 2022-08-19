'use strict'

const Runner = require('./runner')

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
    const knownSubscriptions = new Set()

    // TODO: possible optimization: collect matchedSubscriptions on the fly in Context#setValue
    newAddresses.forEach((newAddress) => {
      const matchedSubscriptions = this.addressToSubscriptions.get(newAddress)

      if (matchedSubscriptions === undefined) return

      for (let j = 0; j < matchedSubscriptions.length; ++j) {
        const subscription = matchedSubscriptions[j]

        if (knownSubscriptions.has(subscription) === true) continue
        knownSubscriptions.add(subscription)

        const isFulfilled = subscription.addresses.every(allAddresses.has, allAddresses)

        if (isFulfilled === true) {
          for (let k = 0; k < subscription.addresses.length; ++k) {
            addresses.add(subscription.addresses[k])
          }

          subscriptions.add(subscription)
        }
      }
    })

    return { addresses, subscriptions }
  }

  dispatch (newAddresses, allAddresses, context) {
    const matches = this.matchSubscriptions(newAddresses, allAddresses)

    // TODO: possible optimization
    // check if matches.subscriptions is empty here instead of in runner.js

    const params = {}

    matches.addresses.forEach((address) => {
      params[address] = context.resolve(address)
    })

    return Runner.runSubscriptions(matches.subscriptions, params)
  }
}

class Context {
  static setManager (manager) {
    this.manager = manager
  }

  constructor () {
    // TODO: this probably don't need to be a Map()
    this.store = new Map()
    this.allAddresses = new Set()
    this.newAddresses = new Set()
  }

  needAddress (address) {
    return this.allAddresses.has(address)
  }

  clear () {
    this.store = new Map()
    this.allAddresses = new Set()
    this.newAddresses = new Set()
  }

  setValue (address, value) {
    if (this.allAddresses.size >= MAX_CONTEXT_SIZE) return this

    // cannot optimize for objects because they're pointers
    if (typeof value !== 'object') {
      const oldValue = this.store.get(address)
      if (oldValue === value) return this
    }

    this.store.set(address, value)
    this.allAddresses.add(address)
    this.newAddresses.add(address)

    return this
  }

  dispatch () {
    if (this.newAddresses.size === 0) return []

    const result = Context.manager.dispatch(this.newAddresses, this.allAddresses, this)

    this.newAddresses.clear()

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
