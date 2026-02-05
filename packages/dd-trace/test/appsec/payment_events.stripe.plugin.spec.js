'use strict'

/* eslint-disable camelcase */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')

const Axios = require('axios')
const { describe, it, before, after } = require('mocha')

const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const { withVersions } = require('../setup/mocha')

const { getConfigFresh } = require('../helpers/config')

withVersions('stripe', 'stripe', version => {
  describe('Stripe Payment Events', () => {
    const WEBHOOK_SECRET = 'whsec_FAKE'

    let server, axios

    function webhookRequest (data, secret = WEBHOOK_SECRET, url = '/stripe/webhook') {
      const timestamp = Date.now()
      const jsonStr = JSON.stringify(data)
      const payload = `${timestamp}.${jsonStr}`

      const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex')

      return axios.post(url, jsonStr, {
        headers: {
          'Content-Type': 'application/json',
          'Stripe-Signature': `t=${timestamp},v1=${signature}`
        }
      })
    }

    before(() => {
      return agent.load(['http'], { client: false })
    })

    before((done) => {
      appsec.enable(getConfigFresh({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'payment_events_rules.json')
        }
      }))

      const Stripe = require(`../../../../versions/stripe@${version}`).get()
      const express = require('../../../../versions/express').get()
      const bodyParser = require('../../../../versions/body-parser').get()

      const app = express()
      app.use(bodyParser.json({
        verify: (req, res, buf) => {
          req.rawBody = buf
        }
      }))
      app.use(bodyParser.urlencoded({ extended: true }))

      let stripe

      // mock for stripe API
      app.post('/v1/checkout/sessions', (req, res) => {
        let {
          line_items: [{
            price_data: {
              unit_amount
            },
            quantity
          }],
          mode,
          client_reference_id,
          discounts: [{
            coupon,
            promotion_code
          }],
          shipping_options: [{
            shipping_rate_data: {
              fixed_amount: {
                amount: amount_shipping
              }
            }
          }]
        } = req.body

        if (mode === undefined) return res.json({ error: { type: 'api_error', message: 'missing mode field' } })

        const subtotal = unit_amount * quantity
        let amount_discount = 0

        if (coupon || promotion_code) {
          // hardcoded 10 % discount
          amount_discount = subtotal * 0.1
        }

        amount_shipping = parseInt(amount_shipping)

        const amount_total = subtotal - amount_discount + amount_shipping

        res.json({
          id: 'cs_FAKE',
          amount_total,
          client_reference_id,
          currency: 'eur',
          mode,
          discounts: [{
            coupon,
            promotion_code,
          }],
          livemode: true,
          total_details: {
            amount_discount,
            amount_shipping
          }
        })
      })

      // mock for stripe API
      app.post('/v1/payment_intents', (req, res) => {
        const { amount, currency, payment_method } = req.body

        if (amount === undefined) return res.json({ error: { type: 'api_error', message: 'missing amount field' } })

        res.json({
          id: 'pi_FAKE',
          amount: +amount,
          currency,
          livemode: true,
          payment_method,
        })
      })

      // for tests
      app.post('/stripe/create_checkout_session', async (req, res) => {
        try {
          const result = await stripe.checkout.sessions.create(req.body)
          res.json(result)
        } catch (error) {
          res.status(500).json({ error })
        }
      })

      app.post('/stripe/create_payment_intent', async (req, res) => {
        try {
          const result = await stripe.paymentIntents.create(req.body)
          res.json(result)
        } catch (error) {
          res.status(500).json({ error })
        }
      })

      app.post('/stripe/webhook', async (req, res) => {
        try {
          const event = stripe.webhooks.constructEvent(
            req.rawBody,
            req.headers['stripe-signature'],
            WEBHOOK_SECRET
          )
          res.json(event?.data?.object)
        } catch (error) {
          res.status(403).json({ error })
        }
      })

      app.post('/stripe/webhookAsync', async (req, res) => {
        try {
          const event = await stripe.webhooks.constructEventAsync(
            req.rawBody,
            req.headers['stripe-signature'],
            WEBHOOK_SECRET
          )
          res.json(event?.data?.object)
        } catch (error) {
          res.status(403).json({ error })
        }
      })

      server = app.listen(0, () => {
        const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
        axios = Axios.create({ baseURL: `http://localhost:${port}`, validateStatus: false })
        stripe = Stripe('sk_FAKE', {
          host: 'localhost',
          port,
          protocol: 'http',
          telemetry: false
        })
        done()
      })
    })

    after(() => {
      server.close()
      appsec.disable()
      return agent.close({ ritmReset: false })
    })

    it('should detect checkout session creation', async () => {
      const res = await axios.post('/stripe/create_checkout_session', {
        client_reference_id: 'GabeN',
        line_items: [{
          price_data: {
            currency: 'eur',
            product_data: {
              name: 'test'
            },
            unit_amount: 100
          },
          quantity: 10
        }],
        mode: 'payment',
        discounts: [{
          coupon: 'COUPEZ',
          promotion_code: 'promo_FAKE'
        }],
        shipping_options: [{
          shipping_rate_data: {
            display_name: 'test',
            fixed_amount: {
              amount: 50,
              currency: 'eur'
            },
            type: 'fixed_amount'
          }
        }]
      })

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.equal(span.metrics._sampling_priority_v1, 1)
        assert.equal(span.meta['appsec.events.payments.integration'], 'stripe')
        assert.equal(span.meta['appsec.events.payments.creation.id'], 'cs_FAKE')
        assert.equal(span.metrics['appsec.events.payments.creation.amount_total'], 950) // 100 * 10 * 0.9 + 50
        assert.equal(span.meta['appsec.events.payments.creation.client_reference_id'], 'GabeN')
        assert.equal(span.meta['appsec.events.payments.creation.currency'], 'eur')
        assert.equal(span.meta['appsec.events.payments.creation.discounts.coupon'], 'COUPEZ')
        assert.equal(span.meta['appsec.events.payments.creation.discounts.promotion_code'], 'promo_FAKE')
        assert.equal(span.metrics['appsec.events.payments.creation.livemode'], 1)
        assert.equal(span.metrics['appsec.events.payments.creation.total_details.amount_discount'], 100)
        assert.equal(span.metrics['appsec.events.payments.creation.total_details.amount_shipping'], 50)
      })

      assert.equal(res.status, 200)
      assert.deepEqual(res.data, {
        id: 'cs_FAKE',
        amount_total: 950,
        client_reference_id: 'GabeN',
        currency: 'eur',
        mode: 'payment',
        discounts: [{
          coupon: 'COUPEZ',
          promotion_code: 'promo_FAKE'
        }],
        livemode: true,
        total_details: {
          amount_discount: 100,
          amount_shipping: 50
        }
      })
    })

    it('should not detect unsupported checkout session type', async () => {
      const res = await axios.post('/stripe/create_checkout_session', {
        client_reference_id: 'GabeN',
        line_items: [{
          price_data: {
            currency: 'eur',
            product_data: {
              name: 'test'
            },
            unit_amount: 100
          },
          quantity: 10
        }],
        mode: 'subscription',
        discounts: [{
          coupon: 'COUPEZ',
          promotion_code: 'promo_FAKE'
        }],
        shipping_options: [{
          shipping_rate_data: {
            display_name: 'test',
            fixed_amount: {
              amount: 50,
              currency: 'eur'
            },
            type: 'fixed_amount'
          }
        }]
      })

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.equal(span.metrics._sampling_priority_v1, 1)

        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.integration'))
        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.creation.id'))
        assert(!Object.hasOwn(span.metrics, 'appsec.events.payments.creation.amount_total'))
        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.creation.client_reference_id'))
        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.creation.currency'))
        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.creation.discounts.coupon'))
        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.creation.discounts.promotion_code'))
        assert(!Object.hasOwn(span.metrics, 'appsec.events.payments.creation.livemode'))
        assert(!Object.hasOwn(span.metrics, 'appsec.events.payments.creation.total_details.amount_discount'))
        assert(!Object.hasOwn(span.metrics, 'appsec.events.payments.creation.total_details.amount_shipping'))
      })

      assert.equal(res.status, 200)
      assert.deepEqual(res.data, {
        id: 'cs_FAKE',
        amount_total: 950,
        client_reference_id: 'GabeN',
        currency: 'eur',
        mode: 'subscription',
        discounts: [{
          coupon: 'COUPEZ',
          promotion_code: 'promo_FAKE'
        }],
        livemode: true,
        total_details: {
          amount_discount: 100,
          amount_shipping: 50
        }
      })
    })

    it('should not detect checkout session creation when error occurs', async () => {
      const res = await axios.post('/stripe/create_checkout_session', {
        client_reference_id: 'GabeN',
        line_items: [{
          price_data: {
            currency: 'eur',
            product_data: {
              name: 'test'
            },
            unit_amount: 100
          },
          quantity: 10
        }],
        // missing mode
        discounts: [{
          coupon: 'COUPEZ',
          promotion_code: 'promo_FAKE'
        }],
        shipping_options: [{
          shipping_rate_data: {
            display_name: 'test',
            fixed_amount: {
              amount: 50,
              currency: 'eur'
            },
            type: 'fixed_amount'
          }
        }]
      })

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.equal(span.metrics._sampling_priority_v1, 1)

        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.integration'))
        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.creation.id'))
        assert(!Object.hasOwn(span.metrics, 'appsec.events.payments.creation.amount_total'))
        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.creation.client_reference_id'))
        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.creation.currency'))
        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.creation.discounts.coupon'))
        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.creation.discounts.promotion_code'))
        assert(!Object.hasOwn(span.metrics, 'appsec.events.payments.creation.livemode'))
        assert(!Object.hasOwn(span.metrics, 'appsec.events.payments.creation.total_details.amount_discount'))
        assert(!Object.hasOwn(span.metrics, 'appsec.events.payments.creation.total_details.amount_shipping'))
      })

      assert.equal(res.status, 500)
      assert.equal(res.data.error.raw.message, 'missing mode field')
    })

    it('should detect payment intent creation', async () => {
      const res = await axios.post('/stripe/create_payment_intent', {
        amount: 6969,
        currency: 'eur',
        payment_method: 'pm_FAKE',
      })

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.equal(span.metrics._sampling_priority_v1, 1)
        assert.equal(span.meta['appsec.events.payments.integration'], 'stripe')
        assert.equal(span.meta['appsec.events.payments.creation.id'], 'pi_FAKE')
        assert.equal(span.metrics['appsec.events.payments.creation.amount'], 6969)
        assert.equal(span.meta['appsec.events.payments.creation.currency'], 'eur')
        assert.equal(span.metrics['appsec.events.payments.creation.livemode'], 1)
        assert.equal(span.meta['appsec.events.payments.creation.payment_method'], 'pm_FAKE')
      })

      assert.equal(res.status, 200)
      assert.deepEqual(res.data, {
        id: 'pi_FAKE',
        amount: 6969,
        currency: 'eur',
        livemode: true,
        payment_method: 'pm_FAKE'
      })
    })

    it('should not detect payment intent creation when error occurs', async () => {
      const res = await axios.post('/stripe/create_payment_intent', {
        // missing amount field
        currency: 'eur',
        payment_method: 'pm_FAKE',
      })

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.equal(span.metrics._sampling_priority_v1, 1)

        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.creation.id'))
        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.integration'))
        assert(!Object.hasOwn(span.metrics, 'appsec.events.payments.creation.amount'))
        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.creation.currency'))
        assert(!Object.hasOwn(span.metrics, 'appsec.events.payments.creation.livemode'))
        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.creation.payment_method'))
      })

      assert.equal(res.status, 500)
      assert.equal(res.data.error.raw.message, 'missing amount field')
    })

    it('should detect payment success webhook', async () => {
      const res = await webhookRequest({
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_FAKE',
            amount: 420,
            currency: 'eur',
            livemode: true,
            payment_method: 'pm_FAKE'
          }
        }
      })

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.equal(span.metrics._sampling_priority_v1, 1)
        assert.equal(span.meta['appsec.events.payments.integration'], 'stripe')
        assert.equal(span.meta['appsec.events.payments.success.id'], 'pi_FAKE')
        assert.equal(span.metrics['appsec.events.payments.success.amount'], 420)
        assert.equal(span.meta['appsec.events.payments.success.currency'], 'eur')
        assert.equal(span.metrics['appsec.events.payments.success.livemode'], 1)
        assert.equal(span.meta['appsec.events.payments.success.payment_method'], 'pm_FAKE')
      })

      assert.equal(res.status, 200)
      assert.deepEqual(res.data, {
        id: 'pi_FAKE',
        amount: 420,
        currency: 'eur',
        livemode: true,
        payment_method: 'pm_FAKE',
      })
    })

    it('should detect payment failure webhook', async () => {
      const res = await webhookRequest({
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: 'pi_FAKE',
            amount: 1337,
            currency: 'eur',
            last_payment_error: {
              code: 'card_declined',
              decline_code: 'stolen_card',
              payment_method: {
                id: 'pm_FAKE',
                type: 'card'
              }
            },
            livemode: true
          }
        }
      })

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.equal(span.metrics._sampling_priority_v1, 1)
        assert.equal(span.meta['appsec.events.payments.integration'], 'stripe')
        assert.equal(span.meta['appsec.events.payments.failure.id'], 'pi_FAKE')
        assert.equal(span.metrics['appsec.events.payments.failure.amount'], 1337)
        assert.equal(span.meta['appsec.events.payments.failure.currency'], 'eur')
        assert.equal(span.meta['appsec.events.payments.failure.last_payment_error.code'], 'card_declined')
        assert.equal(span.meta['appsec.events.payments.failure.last_payment_error.decline_code'], 'stolen_card')
        assert.equal(span.meta['appsec.events.payments.failure.last_payment_error.payment_method.id'], 'pm_FAKE')
        assert.equal(span.meta['appsec.events.payments.failure.last_payment_error.payment_method.type'], 'card')
        assert.equal(span.metrics['appsec.events.payments.failure.livemode'], 1)
      })

      assert.equal(res.status, 200)
      assert.deepEqual(res.data, {
        id: 'pi_FAKE',
        amount: 1337,
        currency: 'eur',
        last_payment_error: {
          code: 'card_declined',
          decline_code: 'stolen_card',
          payment_method: {
            id: 'pm_FAKE',
            type: 'card'
          }
        },
        livemode: true
      })
    })

    it('should detect payment cancellation webhook', async () => {
      const res = await webhookRequest({
        type: 'payment_intent.canceled',
        data: {
          object: {
            id: 'pi_FAKE',
            amount: 1337,
            cancellation_reason: 'requested_by_customer',
            currency: 'eur',
            livemode: true
          }
        }
      })

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.equal(span.metrics._sampling_priority_v1, 1)
        assert.equal(span.meta['appsec.events.payments.integration'], 'stripe')
        assert.equal(span.meta['appsec.events.payments.cancellation.id'], 'pi_FAKE')
        assert.equal(span.metrics['appsec.events.payments.cancellation.amount'], 1337)
        assert.equal(span.meta['appsec.events.payments.cancellation.cancellation_reason'], 'requested_by_customer')
        assert.equal(span.meta['appsec.events.payments.cancellation.currency'], 'eur')
        assert.equal(span.metrics['appsec.events.payments.cancellation.livemode'], 1)
      })

      assert.equal(res.status, 200)
      assert.deepEqual(res.data, {
        id: 'pi_FAKE',
        amount: 1337,
        cancellation_reason: 'requested_by_customer',
        currency: 'eur',
        livemode: true
      })
    })

    it('should not detect webhook event with wrong signature', async () => {
      const res = await webhookRequest({
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_FAKE',
            amount: 420,
            currency: 'eur',
            livemode: true,
            payment_method: 'pm_FAKE'
          }
        }
      }, 'WRONG_SECRET')

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.equal(span.metrics._sampling_priority_v1, 1)

        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.integration'))
        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.success.id'))
        assert(!Object.hasOwn(span.metrics, 'appsec.events.payments.success.amount'))
        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.success.currency'))
        assert(!Object.hasOwn(span.metrics, 'appsec.events.payments.success.livemode'))
        assert(!Object.hasOwn(span.metrics, 'appsec.events.payments.success.payment_method'))
      })

      assert.equal(res.status, 403)
      assert.equal(res.data.error.type, 'StripeSignatureVerificationError')
    })

    it('should not detect unsupported webhook type', async () => {
      const res = await webhookRequest({
        type: 'payment_intent.created',
        data: {
          object: {
            id: 'pi_FAKE',
            amount: 420,
            currency: 'eur',
            livemode: true,
            payment_method: 'pm_FAKE'
          }
        }
      })

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.equal(span.metrics._sampling_priority_v1, 1)

        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.integration'))
      })

      assert.equal(res.status, 200)
      assert.deepEqual(res.data, {
        id: 'pi_FAKE',
        amount: 420,
        currency: 'eur',
        livemode: true,
        payment_method: 'pm_FAKE',
      })
    })

    it('should detect payment success webhook when using async decoder', async () => {
      const res = await webhookRequest({
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_FAKE',
            amount: 420,
            currency: 'eur',
            livemode: true,
            payment_method: 'pm_FAKE'
          }
        }
      }, WEBHOOK_SECRET, '/stripe/webhookAsync')

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.equal(span.metrics._sampling_priority_v1, 1)
        assert.equal(span.meta['appsec.events.payments.integration'], 'stripe')
        assert.equal(span.meta['appsec.events.payments.success.id'], 'pi_FAKE')
        assert.equal(span.metrics['appsec.events.payments.success.amount'], 420)
        assert.equal(span.meta['appsec.events.payments.success.currency'], 'eur')
        assert.equal(span.metrics['appsec.events.payments.success.livemode'], 1)
        assert.equal(span.meta['appsec.events.payments.success.payment_method'], 'pm_FAKE')
      })

      assert.equal(res.status, 200)
      assert.deepEqual(res.data, {
        id: 'pi_FAKE',
        amount: 420,
        currency: 'eur',
        livemode: true,
        payment_method: 'pm_FAKE',
      })
    })

    it('should not detect webhook event with wrong signature when using async decoder', async () => {
      const res = await webhookRequest({
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_FAKE',
            amount: 420,
            currency: 'eur',
            livemode: true,
            payment_method: 'pm_FAKE'
          }
        }
      }, 'WRONG_SECRET', '/stripe/webhookAsync')

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.equal(span.metrics._sampling_priority_v1, 1)

        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.integration'))
        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.success.id'))
        assert(!Object.hasOwn(span.metrics, 'appsec.events.payments.success.amount'))
        assert(!Object.hasOwn(span.meta, 'appsec.events.payments.success.currency'))
        assert(!Object.hasOwn(span.metrics, 'appsec.events.payments.success.livemode'))
        assert(!Object.hasOwn(span.metrics, 'appsec.events.payments.success.payment_method'))
      })

      assert.equal(res.status, 403)
      assert.equal(res.data.error.type, 'StripeSignatureVerificationError')
    })
  })
})
