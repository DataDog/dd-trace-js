'use strict'

module.exports = [
  ...require('./ai'),
  ...require('./azure-cosmos'),
  ...require('./azure-durable-functions'),
  ...require('./bullmq'),
  ...require('./claude-agent-sdk'),
  ...require('./graphql'),
  ...require('./graphql-jit'),
  ...require('./langchain'),
  ...require('./langgraph'),
  ...require('./mercurius'),
  ...require('./modelcontextprotocol-sdk'),
  ...require('./openai-agents'),
  ...require('./playwright'),
  ...require('./webdriverio'),
  ...require('./aws-durable-execution-sdk-js'),
]
