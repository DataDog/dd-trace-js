'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const dc = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const WEBHOOK_SECRET = 'whsec_hbar_c_137'

function signedWebhookPayload (data, secret = WEBHOOK_SECRET) {
  const timestamp = Date.now()
  const payload = JSON.stringify(data)
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')

  return {
    payload,
    header: `t=${timestamp},v1=${signature}`,
  }
}

withVersions('stripe', 'stripe', version => {
  describe('stripe instrumentation', () => {
    const constructEventFinishCh = dc.channel('datadog:stripe:constructEvent:finish')
    let Stripe

    before(() => agent.load(['http'], { client: false }))

    before(() => {
      Stripe = require(`../../../versions/stripe@${version}`).get()
    })

    after(() => agent.close({ ritmReset: false }))

    describe('client construction', () => {
      it('returns a fully-formed Stripe instance with `new`', () => {
        const stripe = new Stripe('sk_test_FAKE')

        assert.equal(typeof stripe.checkout?.sessions?.create, 'function')
        assert.equal(typeof stripe.paymentIntents?.create, 'function')
        assert.equal(typeof stripe.webhooks?.constructEvent, 'function')
        assert.equal(typeof stripe.webhooks?.constructEventAsync, 'function')
      })

      it('returns a fully-formed Stripe instance without `new` (call-style)', () => {
        const stripe = Stripe('sk_test_FAKE')

        assert.equal(typeof stripe.checkout?.sessions?.create, 'function')
        assert.equal(typeof stripe.paymentIntents?.create, 'function')
        assert.equal(typeof stripe.webhooks?.constructEvent, 'function')
        assert.equal(typeof stripe.webhooks?.constructEventAsync, 'function')
      })
    })
  })
})
