'use strict'

async function GET () {
  // eslint-disable-next-line n/no-missing-import -- dependency is installed in the integration sandbox
  const { generateText } = await import('ai')
  const model = require('../../model')
  const result = await generateText({
    model,
    prompt: 'Say ok',
    experimental_telemetry: { isEnabled: true },
  })
  return Response.json({ dependency: typeof generateText === 'function' ? 'ai' : 'missing', text: result.text })
}

module.exports = { GET }
