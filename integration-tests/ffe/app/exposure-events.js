'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 1,
  service: 'ffe-test-service',
  version: '1.2.3',
  env: 'test'
})
const express = require('express')
const { channel } = require('dc-polyfill')
const { flaggingProvider } = tracer
const { OpenFeature } = require('@openfeature/server-sdk')

// Only need flush channel for manual flushing in tests
const flushCh = channel('ffe:writers:flush')

OpenFeature.setProvider(flaggingProvider)
const client = OpenFeature.getClient()

const app = express()

app.get('/', async (req, res) => {
  res.end('OK')
})

app.get('/evaluate-flags', async (req, res) => {
  if (!client) {
    return res.status(500).json({ error: 'OpenFeature client not available' })
  }

  try {
    const context1 = {
      targetingKey: 'test-user-123',
      user: 'test-user-123',
      plan: 'premium'
    }

    const booleanResult = await client.getBooleanValue('test-boolean-flag', false, context1)

    const context2 = {
      targetingKey: 'test-user-456',
      user: 'test-user-456',
      tier: 'enterprise'
    }

    const stringResult = await client.getStringValue('test-string-flag', 'default', context2)

    res.json({
      results: {
        boolean: booleanResult,
        string: stringResult
      },
      evaluationsCompleted: 2
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.get('/evaluate-multiple-flags', async (req, res) => {
  if (!client) {
    return res.status(500).json({ error: 'OpenFeature client not available' })
  }

  try {
    const results = []

    const users = [
      { id: 'user-1', attributes: { plan: 'basic' } },
      { id: 'user-2', attributes: { plan: 'premium' } },
      { id: 'user-3', attributes: { plan: 'enterprise', tier: 'gold' } }
    ]

    for (const user of users) {
      const context = {
        targetingKey: user.id,
        user: user.id,
        ...user.attributes
      }

      const boolResult = await client.getBooleanValue('test-boolean-flag', false, context)
      const stringResult = await client.getStringValue('test-string-flag', 'default', context)

      results.push({
        user: user.id,
        boolean: boolResult,
        string: stringResult
      })
    }

    res.json({
      results,
      evaluationsCompleted: users.length * 2
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.get('/flush', async (req, res) => {
  flushCh.publish()
  res.json({ flushed: true })
})

const server = app.listen(process.env.APP_PORT || 0, (error) => {
  if (error) {
    throw error
  }
  process.send?.({ port: server.address().port })
})
