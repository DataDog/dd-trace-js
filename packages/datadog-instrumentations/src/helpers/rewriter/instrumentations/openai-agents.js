'use strict'

const moduleName = '@openai/agents-openai'
const versionRange = '>=0.7.0'
const functionQuery = {
  methodName: 'constructor',
  className: 'OpenAIChatCompletionsModel',
  kind: 'Sync',
}
const channelName = 'OpenAIChatCompletionsModel_constructor'

module.exports = [
  {
    module: {
      name: moduleName,
      versionRange,
      filePath: 'dist/openaiChatCompletionsModel.js',
    },
    functionQuery,
    channelName,
  },
  {
    module: {
      name: moduleName,
      versionRange,
      filePath: 'dist/openaiChatCompletionsModel.mjs',
    },
    functionQuery,
    channelName,
  },
]
