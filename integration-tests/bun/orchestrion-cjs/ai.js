'use strict'

const tracer = require('dd-trace')

tracer.init({
  startupLogs: false,
  url: process.env.DD_TRACE_AGENT_URL,
  flushInterval: 10,
})

const { createOpenAI } = require('@ai-sdk/openai')
const { generateText } = require('ai')

const finish = require('../finish')
const startOpenAIServer = require('./openai-server')

startOpenAIServer().then(async ({ baseURL, server }) => {
  const openai = createOpenAI({ baseURL, apiKey: 'test' })

  await generateText({ model: openai.chat('gpt-4o-mini'), prompt: 'Hello' })

  server.close(finish)
})
