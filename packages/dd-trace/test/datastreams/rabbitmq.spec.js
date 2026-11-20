'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../setup/core')
const { normalizeRabbitMQName } = require('../../src/datastreams/rabbitmq')

describe('normalizeRabbitMQName', () => {
  const cases = [
    // server-named queues
    ['amq.gen-JzTY20BRgKO-HjmUJj0wLg', 'amq.gen-*'],
    // direct reply-to
    ['amq.rabbitmq.reply-to', 'amq.rabbitmq.reply-to'],
    ['amq.rabbitmq.reply-to.g1h2AA5yZXBseUAxMjcuMC4wLjE6NTY3Mg==', 'amq.rabbitmq.reply-to'],
    // MassTransit bus and temporary endpoints
    ['ip-10-0-1-2_PaymentService_bus_ybyyyyb6tamq6nr4bdpwzyhwbo', '*_PaymentService_bus_*'],
    ['HOST01_OrderApi_BUS_ABC123XYZ', '*_OrderApi_bus_*'],
    ['build_agent_01_Worker_bus_k3j4h5g6', '*_Worker_bus_*'],
    // Wolverine node queues
    ['wolverine.control.3', 'wolverine.control.*'],
    ['wolverine.response.8f14e45f-ceea-467a-9f3a-6b1f1e2c0a11', 'wolverine.response.*'],
    ['wolverine.replies.node-1', 'wolverine.replies.*'],
    // trailing UUID
    ['callback-8f14e45f-ceea-467a-9f3a-6b1f1e2c0a11', 'callback-*'],
    ['reply-orders-8F14E45F-CEEA-467A-9F3A-6B1F1E2C0A11', 'reply-orders-*'],
    ['reply_8f14e45fceea467a9f3a6b1f1e2c0a11', 'reply_*'],
    ['worker.8f14e45f-ceea-467a-9f3a-6b1f1e2c0a11', 'worker.*'],
    // trailing long hex (16 or more hex chars)
    ['membership-9f8e7d6c5b4a39281706f5e4d3c2b1a0', 'membership-*'],
    ['session_0123456789abcdef', 'session_*'],
    // negatives: names that must stay unchanged
    ['orders', 'orders'],
    ['orders-v2', 'orders-v2'],
    ['queue-abc123', 'queue-abc123'],
    ['payments.events', 'payments.events'],
    ['session_0123456789abcde', 'session_0123456789abcde'], // 15 hex chars
    ['0123456789abcdef0123', '0123456789abcdef0123'], // no separator
    ['amq.direct', 'amq.direct'],
    ['wolverine.events.orders', 'wolverine.events.orders'],
    ['my_bus_queue', 'my_bus_queue'],
    ['PaymentService_bus_', 'PaymentService_bus_'],
    ['_PaymentService_bus_abc123', '_PaymentService_bus_abc123'], // empty host segment
  ]

  for (const [input, expected] of cases) {
    it(`normalizes ${input} to ${expected}`, () => {
      assert.strictEqual(normalizeRabbitMQName(input), expected)
    })
  }

  it('returns null, undefined and empty input unchanged', () => {
    assert.strictEqual(normalizeRabbitMQName(null), null)
    assert.strictEqual(normalizeRabbitMQName(undefined), undefined)
    assert.strictEqual(normalizeRabbitMQName(''), '')
  })
})
