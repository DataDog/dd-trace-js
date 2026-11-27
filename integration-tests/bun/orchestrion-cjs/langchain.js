'use strict'

const tracer = require('dd-trace')

tracer.init({
  startupLogs: false,
  url: process.env.DD_TRACE_AGENT_URL,
  flushInterval: 10,
})

const { ChatOpenAI } = require('@langchain/openai')

const finish = require('../finish')
const startOpenAIServer = require('./openai-server')

startOpenAIServer().then(async ({ baseURL, server }) => {
  const model = new ChatOpenAI({ model: 'gpt-4o-mini', apiKey: 'test', configuration: { baseURL } })

  await model.invoke('Hello')

  server.close(finish)
})
