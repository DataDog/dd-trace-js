'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 1,
})

const express = require('express')
const { channel } = require('dc-polyfill')

// FFE diagnostic channels for publishing events, only for testing
const exposureSubmitCh = channel('ffe:exposure:submit')
const flushCh = channel('ffe:writers:flush')

const app = express()

app.get('/', async (req, res) => {
  res.end('OK')
})

app.get('/submit-exposure', async (req, res) => {
  // Check if FFE is enabled
  if (process.env.DD_FFE_ENABLED !== 'true') {
    return res.status(500).json({ error: 'FFE module not available' })
  }

  // Submit a single exposure event
  const exposureEvent = {
    timestamp: Date.now(),
    allocation: { key: 'test_allocation_123' },
    flag: { key: 'test_flag' },
    variant: { key: 'variant_a' },
    subject: {
      id: 'user_123',
      type: 'user',
      attributes: { plan: 'premium' }
    }
  }
  exposureSubmitCh.publish(exposureEvent)
  res.json({ submitted: 1, event: exposureEvent })
})

app.get('/submit-multiple-exposures', async (req, res) => {
  // Submit multiple exposure events
  const exposureEvents = [
    {
      timestamp: Date.now(),
      allocation: { key: 'allocation_1' },
      flag: { key: 'flag_1' },
      variant: { key: 'control' },
      subject: { id: 'user_1', type: 'user' }
    },
    {
      timestamp: Date.now() + 1,
      allocation: { key: 'allocation_2' },
      flag: { key: 'flag_2' },
      variant: { key: 'treatment' },
      subject: { id: 'user_2', type: 'user' }
    },
    {
      timestamp: Date.now() + 2,
      allocation: { key: 'allocation_3' },
      flag: { key: 'flag_3' },
      variant: { key: 'variant_b' },
      subject: {
        id: 'user_3',
        type: 'user',
        attributes: { tier: 'enterprise' }
      }
    }
  ]

  exposureSubmitCh.publish(exposureEvents)
  res.json({ submitted: exposureEvents.length, events: exposureEvents })
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
