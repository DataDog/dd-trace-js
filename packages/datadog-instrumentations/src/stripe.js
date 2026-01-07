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

function wrapStripe (Stripe) {
  return function wrappedStripe () {
    let stripe = Stripe.apply(this, arguments)

    if (this instanceof Stripe) {
      stripe = this
    }

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

    return stripe
  }
}

addHook({
  name: 'stripe',
  versions: ['>=7.0.0']
}, Stripe => {
  return shimmer.wrapFunction(Stripe, wrapStripe)
})
