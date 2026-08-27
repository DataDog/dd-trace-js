'use strict'

async function GET () {
  // eslint-disable-next-line n/no-missing-import -- dependency is installed in the integration sandbox
  const { generateText } = await import('ai')
  return Response.json({ dependency: typeof generateText === 'function' ? 'ai' : 'missing' })
}

module.exports = { GET }
