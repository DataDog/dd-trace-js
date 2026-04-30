'use strict'

const assert = require('node:assert/strict')

const { after, before, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

withVersions('stripe', 'stripe', version => {
  describe('stripe instrumentation', () => {
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
