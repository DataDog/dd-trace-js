'use strict'

async function GET () {
  const { run } = await import('../../esm-entry.mjs')
  return Response.json(await run())
}

module.exports = { GET }
