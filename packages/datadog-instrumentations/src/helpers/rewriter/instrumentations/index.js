'use strict'

module.exports = [
  ...require('./ai'),
  ...require('./azure-cosmos'),
  ...require('./bullmq'),
<<<<<<< feat/claude-agent-sdk-integration
  ...require('./claude-agent-sdk'),
=======
  ...require('./graphql'),
>>>>>>> master
  ...require('./langchain'),
  ...require('./langgraph'),
  ...require('./modelcontextprotocol-sdk'),
  ...require('./playwright'),
  ...require('./aws-durable-execution-sdk-js'),
]
