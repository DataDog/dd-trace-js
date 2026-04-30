'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const checkoutSessionCreateFinishCh = channel('datadog:stripe:checkoutSession:create:finish')
const paymentIntentCreateFinishCh = channel('datadog:stripe:paymentIntent:create:finish')
const constructEventFinishCh = channel('datadog:stripe:constructEvent:finish')

function wrapSessionCreate (create) {
  return function wrappedSessionCreate () {
    const promise = create.apply(this, arguments)

    if (!checkoutSessionCreateFinishCh.hasSubscribers) return promise

    return promise.then((result) => {
      checkoutSessionCreateFinishCh.publish(result)
      return result
    })
  }
}

function wrapPaymentIntentCreate (create) {
  return function wrappedPaymentIntentCreate () {
    const promise = create.apply(this, arguments)

    if (!paymentIntentCreateFinishCh.hasSubscribers) return promise

    return promise.then((result) => {
      paymentIntentCreateFinishCh.publish(result)
      return result
    })
  }
}

function wrapConstructEvent (constructEvent) {
  return function wrappedConstructEvent () {
    const result = constructEvent.apply(this, arguments)

    // no need to check for hasSubscribers,
    // if it's false, the publish function will be noop
    constructEventFinishCh.publish(result)

    return result
  }
}

function wrapConstructEventAsync (constructEventAsync) {
  return function wrappedConstructEventAsync () {
    const promise = constructEventAsync.apply(this, arguments)

    if (!constructEventFinishCh.hasSubscribers) return promise

    return promise.then((result) => {
      constructEventFinishCh.publish(result)
      return result
    })
  }
}

function instrumentStripeInstance (stripe) {
  if (typeof stripe.checkout?.sessions?.create === 'function') {
    shimmer.wrap(stripe.checkout.sessions, 'create', wrapSessionCreate)
  }
  if (typeof stripe.paymentIntents?.create === 'function') {
    shimmer.wrap(stripe.paymentIntents, 'create', wrapPaymentIntentCreate)
  }
  if (typeof stripe.webhooks?.constructEvent === 'function') {
    shimmer.wrap(stripe.webhooks, 'constructEvent', wrapConstructEvent)
  }
  if (typeof stripe.webhooks?.constructEventAsync === 'function') {
    shimmer.wrap(stripe.webhooks, 'constructEventAsync', wrapConstructEventAsync)
  }
}

// stripe <22: the constructor mutates this (when invoked with 'new') and
// returns nothing; without 'new' it delegates to 'new Stripe(...)' and returns
// that result. We need to instrument whichever object actually got populated
function wrapLegacyStripe (Stripe) {
  return function wrappedStripe () {
    const result = Stripe.apply(this, arguments)
    const stripe = this instanceof Stripe ? this : result
    instrumentStripeInstance(stripe)
    return stripe
  }
}

// stripe >=22: the constructor is a factory that always returns a fresh Stripe
// instance regardless of 'new', so we just instrument and forward the result
function wrapStripe (Stripe) {
  return function wrappedStripe () {
    const stripe = Stripe.apply(this, arguments)
    instrumentStripeInstance(stripe)
    return stripe
  }
}

addHook({
  name: 'stripe',
  versions: ['9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '>=20.0.0 <22'],
}, Stripe => shimmer.wrapFunction(Stripe, wrapLegacyStripe))

addHook({
  name: 'stripe',
  versions: ['>=22'],
}, Stripe => shimmer.wrapFunction(Stripe, wrapStripe))
