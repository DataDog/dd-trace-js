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
// Note: We'll eventually need to figure out how this works for dd-trace-api users (SSI compatibility)
const { openfeature } = tracer
const { OpenFeature } = require('@openfeature/server-sdk')

// Used to test manual flushing capabilities
const flushCh = channel('ffe:writers:flush')

OpenFeature.setProvider(openfeature)
const client = OpenFeature.getClient()

const app = express()

// Used to test remote config polling capabilities
app.get('/', async (req, res) => {
  res.end('OK')
})

app.get('/evaluate-flags', async (req, res) => {
  if (!client) {
    return res.status(500).json({ error: 'OpenFeature client not available' })
  }

  try {
    const booleanResult = await client.getBooleanValue('test-boolean-flag', false, {
      targetingKey: 'test-user-123',
      user: 'test-user-123',
      plan: 'premium'
    })

    const stringResult = await client.getStringValue('test-string-flag', 'default', {
      targetingKey: 'test-user-456',
      user: 'test-user-456',
      tier: 'enterprise'
    })

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
