'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const Sqs = require('../src/services/sqs')

describe('SQS generateTags', () => {
  const queueUrl = 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue'

  it('tags the queue URL the request addresses', () => {
    const tags = new Sqs({}, {}).generateTags({ QueueUrl: queueUrl }, 'sendMessage')
    assert.ok(tags)

    assert.strictEqual(tags['aws.sqs.queue.url'], queueUrl)
    assert.strictEqual(tags.queuename, 'my-queue')
    assert.strictEqual(tags['cloud.resource_id'], 'arn:aws:sqs:us-east-1:123456789012:my-queue')
  })

  it('does not tag a queue URL when the request only names the queue', () => {
    const tags = new Sqs({}, {}).generateTags({ QueueName: 'my-queue' }, 'createQueue')
    assert.ok(tags)

    assert.strictEqual(tags.queuename, 'my-queue')
    assert.ok(!('aws.sqs.queue.url' in tags))
  })
})
