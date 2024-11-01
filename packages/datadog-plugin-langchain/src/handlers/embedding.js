'use strict'

const { truncate } = require('../util')

function getStartTags (ctx) {
  const tags = {}

  const inputTexts = ctx.args?.[0]

  if (typeof inputTexts === 'string') {
    // embed query
    tags['langchain.request.inputs.0.text'] = truncate(inputTexts)
    tags['langchain.request.input_counts'] = 1
  } else {
    // embed documents
    for (const idx in inputTexts) {
      const inputText = inputTexts[idx]
      tags[`langchain.request.inputs.${idx}.text`] = truncate(inputText)
    }
    tags['langchain.request.input_counts'] = inputTexts.length
  }

  return tags
}

function getEndTags (ctx) {
  const tags = {}

  const { result } = ctx
  if (!Array.isArray(result)) return

  if (Array.isArray(result[0])) {
    for (const idx in result) {
      const output = result[idx]
      tags[`langchain.response.outputs.${idx}.embedding_length`] = output.length
    }
  } else {
    tags['langchain.response.outputs.embedding_length'] = result.length
  }

  return tags
}

function extractProvider (ctx) {
  const instance = ctx.instance
  return instance.constructor.name.split('Embeddings')[0].toLowerCase()
}

function extractApiKey (ctx) {
  const instance = ctx.instance
  const apiKey = instance.clientConfig?.apiKey
  if (!apiKey || apiKey.length < 4) return
  return `...${apiKey.slice(-4)}`
}

module.exports = {
  getStartTags,
  getEndTags,
  extractProvider,
  extractApiKey
}
