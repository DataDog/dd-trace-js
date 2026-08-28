'use strict'

const express = require('express')
const { generateText } = require('ai')
const model = require('../../app/model')

const app = express()
app.use(async (_req, res) => {
  const result = await generateText({
    model,
    prompt: 'Say ok',
    experimental_telemetry: { isEnabled: true },
  })
  res.json({ dependency: 'express', text: result.text })
})

module.exports = (req, res) => app(req, res)
