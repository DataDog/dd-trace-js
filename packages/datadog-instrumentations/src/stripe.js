'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const checkoutSessionCreateFinishCh = channel('datadog:stripe:checkoutSession:create:finish')
const paymentIntentCreateFinishCh = channel('datadog:stripe:paymentIntent:create:finish')
const constructEventFinishCh = channel('datadog:stripe:constructEvent:finish')

function wrapSessionCreate (create) {
  return function wrappedSessionCreate (...args) {
    const promise = create.apply(this, args)

    if (!checkoutSessionCreateFinishCh.hasSubscribers) return promise

    return promise.then((result) => {
      checkoutSessionCreateFinishCh.publish(result)
      return result
    })
  }
}

function wrapPaymentIntentCreate (create) {
  return function wrappedPaymentIntentCreate (...args) {
    const promise = create.apply(this, args)

    if (!paymentIntentCreateFinishCh.hasSubscribers) return promise

    return promise.then((result) => {
      paymentIntentCreateFinishCh.publish(result)
      return result
    })
  }
}

function wrapConstructEvent (constructEvent) {
  return function wrappedConstructEvent (...args) {
    const result = constructEvent.apply(this, args)

    // no need to check for hasSubscribers,
    // if it's false, the publish function will be noop
    constructEventFinishCh.publish(result)

    return result
  }
}

function wrapConstructEventAsync (constructEventAsync) {
  return function wrappedConstructEventAsync (...args) {
    const promise = constructEventAsync.apply(this, args)

    if (!constructEventFinishCh.hasSubscribers) return promise

    return promise.then((result) => {
      constructEventFinishCh.publish(result)
      return result
    })
  }
}

const wrappedMethods = new WeakSet()

// Stripe >=9 <11.10 and >=18 share `webhooks` across clients. Stripe >=11.10 <18
// creates it per client. checkout.sessions and paymentIntents are separate for each client.
// Rewrapping shared webhook methods adds one layer per client, causing duplicate
// publications and eventually a stack overflow. Track installed functions so replacements
// still get wrapped and restored wrappers are reused.
/**
 * @param {object|undefined} target
 * @param {string} name
 * @param {Function} wrapper
 */
function wrapOnce (target, name, wrapper) {
  if (typeof target?.[name] !== 'function' || wrappedMethods.has(target[name])) return

  shimmer.wrap(target, name, wrapper)
  wrappedMethods.add(target[name])
}

function instrumentStripeInstance (stripe) {
  wrapOnce(stripe.checkout?.sessions, 'create', wrapSessionCreate)
  wrapOnce(stripe.paymentIntents, 'create', wrapPaymentIntentCreate)
  wrapOnce(stripe.webhooks, 'constructEvent', wrapConstructEvent)
  wrapOnce(stripe.webhooks, 'constructEventAsync', wrapConstructEventAsync)
}

// stripe <22: the constructor mutates this (when invoked with 'new') and
// returns nothing; without 'new' it delegates to 'new Stripe(...)' and returns
// that result. We need to instrument whichever object actually got populated
function wrapLegacyStripe (Stripe) {
  return function wrappedStripe (...args) {
    const result = Stripe.apply(this, args)
    const stripe = this instanceof Stripe ? this : result
    instrumentStripeInstance(stripe)
    return stripe
  }
}

// stripe >=22: the constructor is a factory that always returns a fresh Stripe
// instance regardless of 'new', so we just instrument and forward the result
function wrapStripe (Stripe) {
  return function wrappedStripe (...args) {
    const stripe = Stripe.apply(this, args)
    instrumentStripeInstance(stripe)
    return stripe
  }
}

addHook({
  name: 'stripe',
  versions: ['>=9 <22'],
}, Stripe => shimmer.wrapFunction(Stripe, wrapLegacyStripe))

addHook({
  name: 'stripe',
  versions: ['>=22'],
}, Stripe => shimmer.wrapFunction(Stripe, wrapStripe))
