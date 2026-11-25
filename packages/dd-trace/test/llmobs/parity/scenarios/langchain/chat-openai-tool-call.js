'use strict'

const { finish } = require('../common')
const helpers = require('./helpers')

async function main () {
  const tracer = helpers.loadLangChainTracer()
  const model = helpers.chatOpenAI({ temperature: 0 }).bindTools([{
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the weather for a city.',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  }])
  await model.invoke([['user', 'What is the weather in Paris?']])
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
