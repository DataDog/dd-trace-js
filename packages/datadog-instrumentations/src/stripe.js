'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const checkoutSessionCreateFinishCh = channel('datadog:stripe:checkoutSession:create:finish')
const paymentIntentCreateFinishCh = channel('datadog:stripe:paymentIntent:create:finish')
const constructEventFinishCh = channel('datadog:stripe:constructEvent:finish')

function wrapSessionCreate (create) {
  return function wrappedSessionCreate () {
    let promise = create.apply(this, arguments)

    if (checkoutSessionCreateFinishCh.hasSubscribers) {
      promise = promise.then((result) => {
        checkoutSessionCreateFinishCh.publish(result)
      })
    }

    return promise
  }
}

addHook({
  name: 'stripe',
  file: 'cjs/resources/Checkout/Sessions.js',
  versions: ['>=18']
}, Sessions => {
  shimmer.wrap(Sessions.Sessions.prototype, 'create', wrapSessionCreate)
})

function wrapPaymentIntentCreate (create) {
  return function wrappedPaymentIntentCreate () {
    let promise = create.apply(this, arguments)

    if (paymentIntentCreateFinishCh.hasSubscribers) {
      promise = promise.then((result) => {
        paymentIntentCreateFinishCh.publish(result)
      })
    }

    return promise
  }
}

addHook({
  name: 'stripe',
  file: 'cjs/resources/PaymentIntents.js',
  versions: ['>=18']
}, PaymentIntents => {
  shimmer.wrap(PaymentIntents.PaymentIntents.prototype, 'create', wrapPaymentIntentCreate)
})

function wrapConstructEvent (constructEvent) {
  return function wrappedConstructEvent () {
    const result = constructEvent.apply(this, arguments)

    constructEventFinishCh.publish(result)

    return result
  }
}

function wrapCreateWebhooks (createWebhooks) {
  return function wrappedCreateWebhooks () {
    const result = createWebhooks.apply(this, arguments)

    shimmer.wrap(result, 'constructEvent', wrapConstructEvent)
    // constructEventAsync

    return result
  }
}

addHook({
  name: 'stripe',
  file: 'cjs/Webhooks.js',
  versions: ['>=18']
}, Webhooks => {
  shimmer.wrap(Webhooks, 'createWebhooks', wrapCreateWebhooks)
})
