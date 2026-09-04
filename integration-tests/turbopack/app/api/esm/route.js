'use strict'

async function GET () {
  // eslint-disable-next-line n/no-missing-import -- dependency is installed in the integration sandbox
  const { wrappedGenerateText } = await import('foreign-ai-wrapper')
  const model = require('../../model')
  const result = await wrappedGenerateText({
    model,
    prompt: 'Say ok',
    experimental_telemetry: { isEnabled: true },
  })
  return Response.json({
    dependency: typeof wrappedGenerateText === 'function' ? 'foreign-ai-wrapper' : 'missing',
    text: result.text,
  })
}

module.exports = { GET }
