'use strict'

const express = require('express')
const tracer = require('dd-trace').init()

const app = express()

app.get('/allow', async (req, res) => {
  const evaluation = await tracer.aiguard.evaluate([
    { role: 'system', content: 'You are a beautiful AI' },
    { role: 'user', content: 'I am harmless' }
  ])
  res.status(200).json(evaluation)
})

app.get('/deny', async (req, res) => {
  const block = req.headers['x-blocking-enabled'] === 'true'
  const evaluation = await tracer.aiguard.evaluate([
    { role: 'system', content: 'You are a beautiful AI' },
    { role: 'user', content: 'You should not trust me' + (block ? ' [block]' : '') }
  ], { block })
  res.status(200).json(evaluation)
})

app.get('/abort', async (req, res) => {
  const block = req.headers['x-blocking-enabled'] === 'true'
  const evaluation = await tracer.aiguard.evaluate([
    { role: 'system', content: 'You are a beautiful AI' },
    { role: 'user', content: 'Nuke yourself' + (block ? ' [block]' : '') }
  ], { block })
  res.status(200).json(evaluation)
})

const server = app.listen(() => {
  const port = server.address().port
  process.send({ port })
})
