'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { getSubscriptionName, getTopicName } = require('../src/resource-names')

describe('Pub/Sub resource names', () => {
  it('accepts full topic and subscription names', () => {
    assert.strictEqual(getTopicName('projects/commerce/topics/orders'), 'projects/commerce/topics/orders')
    assert.strictEqual(
      getSubscriptionName('projects/analytics/subscriptions/warehouse-orders'),
      'projects/analytics/subscriptions/warehouse-orders'
    )
  })

  for (const value of [
    'orders',
    'push-subscription-topic',
    'projects/commerce/topics/',
    'projects//topics/orders',
    'projects/commerce/subscriptions/orders',
    'projects/{{projectId}}/topics/orders',
    'projects/commerce/topics/orders/extra',
    undefined,
    42,
  ]) {
    it(`rejects the topic name ${String(value)}`, () => {
      assert.strictEqual(getTopicName(value), undefined)
    })
  }

  for (const value of [
    'warehouse-orders',
    'projects/analytics/topics/warehouse-orders',
    'projects/{{projectId}}/subscriptions/warehouse-orders',
    undefined,
  ]) {
    it(`rejects the subscription name ${String(value)}`, () => {
      assert.strictEqual(getSubscriptionName(value), undefined)
    })
  }
})
