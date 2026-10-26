'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

withVersions('stripe', 'stripe', version => {
  describe('stripe instrumentation', () => {
    let Stripe

    before(() => agent.load(['http'], { client: false }))

    before(() => {
      Stripe = require(`../../../versions/stripe@${version}`).get()
    })

    after(() => agent.close())

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

    describe('shared webhooks', () => {
      const constructEventFinishCh = dc.channel('datadog:stripe:constructEvent:finish')
      const payload = JSON.stringify({ id: 'evt_test', object: 'event' })
      const secret = 'whsec_FAKE'

      let publishes

      function onPublish () {
        publishes++
      }

      beforeEach(() => {
        publishes = 0
        constructEventFinishCh.subscribe(onPublish)
      })

      afterEach(() => {
        constructEventFinishCh.unsubscribe(onPublish)
      })

      it('does not stack wrappers when many clients are created', async () => {
        let stripe
        for (let i = 0; i < 20_000; i++) {
          stripe = new Stripe('sk_test_FAKE')
        }

        const header = stripe.webhooks.generateTestHeaderString({ payload, secret })

        assert.equal(stripe.webhooks.constructEvent(payload, header, secret).id, 'evt_test')
        assert.equal(publishes, 1)

        const promise = stripe.webhooks.constructEventAsync(payload, header, secret)
        assert.equal(typeof promise.then, 'function')
        assert.equal((await promise).id, 'evt_test')
        assert.equal(publishes, 2)
      })
    })
  })
})
