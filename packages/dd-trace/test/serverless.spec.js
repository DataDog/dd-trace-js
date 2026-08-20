'use strict'

const assert = require('node:assert/strict')

const { describe, it, afterEach } = require('mocha')

require('./setup/core')

const { getServerlessPlatformTags, enableGCPPubSubPushSubscription } = require('../src/serverless')
const agent = require('./plugins/agent')

describe('enableGCPPubSubPushSubscription', () => {
  const originalKService = process.env.K_SERVICE
  const originalGcpPubsubPush = process.env.DD_TRACE_GCP_PUBSUB_PUSH_ENABLED

  afterEach(() => {
    if (originalKService === undefined) delete process.env.K_SERVICE
    else process.env.K_SERVICE = originalKService
    if (originalGcpPubsubPush === undefined) delete process.env.DD_TRACE_GCP_PUBSUB_PUSH_ENABLED
    else process.env.DD_TRACE_GCP_PUBSUB_PUSH_ENABLED = originalGcpPubsubPush
  })

  it('is false when K_SERVICE is not set', () => {
    delete process.env.K_SERVICE
    assert.strictEqual(enableGCPPubSubPushSubscription(), false)
  })

  it('is true when K_SERVICE is set and the env var defaults to true', () => {
    process.env.K_SERVICE = 'svc'
    delete process.env.DD_TRACE_GCP_PUBSUB_PUSH_ENABLED
    assert.strictEqual(enableGCPPubSubPushSubscription(), true)
  })

  it('is false when the user opts out via DD_TRACE_GCP_PUBSUB_PUSH_ENABLED=false', () => {
    process.env.K_SERVICE = 'svc'
    process.env.DD_TRACE_GCP_PUBSUB_PUSH_ENABLED = 'false'
    assert.strictEqual(enableGCPPubSubPushSubscription(), false)
  })
})

describe('Vercel span metadata', () => {
  const environment = process.env

  afterEach(async () => {
    process.env = environment
    await agent.close()
  })

  it('does not add tags outside Vercel', async () => {
    process.env = {
      ...environment,
      VERCEL_DEPLOYMENT_ID: 'dpl_123',
      VERCEL_ENV: 'preview',
      VERCEL_PROJECT_ID: 'prj_123',
      VERCEL_REGION: 'iad1',
      VERCEL_TARGET_ENV: 'staging',
    }
    delete process.env.VERCEL

    const tracer = await agent.load([], [], { service: 'vercel-metadata-test' })
    tracer.startSpan('non-vercel-span').finish()

    await agent.assertSomeTraces(traces => {
      const { meta } = traces[0][0]
      assert.strictEqual(meta['vercel.project_id'], undefined)
      assert.strictEqual(meta['vercel.environment'], undefined)
      assert.strictEqual(meta['vercel.region'], undefined)
    })
  })

  it('adds present Vercel metadata to encoded spans', async () => {
    process.env = {
      ...environment,
      VERCEL: '1',
      VERCEL_DEPLOYMENT_ID: 'dpl_123',
      VERCEL_ENV: 'preview',
      VERCEL_PROJECT_ID: 'prj_123',
      VERCEL_REGION: 'iad1',
      VERCEL_TARGET_ENV: 'staging',
    }

    const tracer = await agent.load([], [], {
      service: 'vercel-metadata-test',
      tags: { 'vercel.region': 'custom-region' },
    })
    tracer.startSpan('vercel-span').finish()

    await agent.assertSomeTraces(traces => {
      assert.deepStrictEqual(Object.fromEntries(
        Object.entries(traces[0][0].meta).filter(([name]) => name.startsWith('vercel.'))
      ), {
        'vercel.project_id': 'prj_123',
        'vercel.environment': 'preview',
        'vercel.region': 'custom-region',
      })
    })
  })

  it('discovers only present Vercel metadata as platform tags', () => {
    process.env = {
      ...environment,
      VERCEL: '1',
      VERCEL_ENV: 'preview',
      VERCEL_PROJECT_ID: 'prj_123',
    }

    assert.deepStrictEqual(getServerlessPlatformTags(), [
      'vercel.project_id', 'prj_123',
      'vercel.environment', 'preview',
    ])
  })

  it('discovers Vercel metadata when project ID is missing', () => {
    process.env = {
      ...environment,
      VERCEL: '1',
      VERCEL_ENV: 'preview',
    }

    assert.deepStrictEqual(getServerlessPlatformTags(), [
      'vercel.environment', 'preview',
    ])
  })
})
