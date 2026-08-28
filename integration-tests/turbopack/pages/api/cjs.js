'use strict'

const express = require('express')
const { generateText } = require('ai')

const model = require('../../app/model')

const app = express()
app.use(async (_request, response) => {
  const result = await generateText({
    model,
    prompt: 'Say ok',
    experimental_telemetry: { isEnabled: true },
  })
  response.json({ dependency: 'express', text: result.text })
})

module.exports = (request, response) => app(request, response)
