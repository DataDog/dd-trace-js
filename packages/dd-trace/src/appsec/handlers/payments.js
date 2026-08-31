'use strict'

const addresses = require('../addresses')
const waf = require('../waf')

function onStripeCheckoutSessionCreate (payload) {
  if (payload?.mode !== 'payment') return

  waf.run({
    persistent: {
      [addresses.PAYMENT_CREATION]: {
        integration: 'stripe',
        id: payload.id,
        amount_total: payload.amount_total,
        client_reference_id: payload.client_reference_id,
        currency: payload.currency,
        'discounts.coupon': payload.discounts?.[0]?.coupon,
        'discounts.promotion_code': payload.discounts?.[0]?.promotion_code,
        livemode: payload.livemode,
        'total_details.amount_discount': payload.total_details?.amount_discount,
        'total_details.amount_shipping': payload.total_details?.amount_shipping,
      },
    },
  })
}

function onStripePaymentIntentCreate (payload) {
  if (payload === null || typeof payload !== 'object') return

  waf.run({
    persistent: {
      [addresses.PAYMENT_CREATION]: {
        integration: 'stripe',
        id: payload.id,
        amount: payload.amount,
        currency: payload.currency,
        livemode: payload.livemode,
        payment_method: payload.payment_method,
      },
    },
  })
}

function onStripeConstructEvent (payload) {
  const object = payload?.data?.object
  if (object === null || typeof object !== 'object') return

  let persistent

  switch (payload.type) {
    case 'payment_intent.succeeded':
      persistent = {
        [addresses.PAYMENT_SUCCESS]: {
          integration: 'stripe',
          id: object.id,
          amount: object.amount,
          currency: object.currency,
          livemode: object.livemode,
          payment_method: object.payment_method,
        },
      }
      break

    case 'payment_intent.payment_failed':
      persistent = {
        [addresses.PAYMENT_FAILURE]: {
          integration: 'stripe',
          id: object.id,
          amount: object.amount,
          currency: object.currency,
          'last_payment_error.code': object.last_payment_error?.code,
          'last_payment_error.decline_code': object.last_payment_error?.decline_code,
          'last_payment_error.payment_method.id': object.last_payment_error?.payment_method?.id,
          'last_payment_error.payment_method.type': object.last_payment_error?.payment_method?.type,
          livemode: object.livemode,
        },
      }
      break

    case 'payment_intent.canceled':
      persistent = {
        [addresses.PAYMENT_CANCELLATION]: {
          integration: 'stripe',
          id: object.id,
          amount: object.amount,
          cancellation_reason: object.cancellation_reason,
          currency: object.currency,
          livemode: object.livemode,
        },
      }
      break

    default:
      return
  }

  waf.run({ persistent })
}

module.exports = {
  onStripeCheckoutSessionCreate,
  onStripePaymentIntentCreate,
  onStripeConstructEvent,
}
