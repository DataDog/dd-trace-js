'use strict'

const { truncate } = require('../util')

function getStartTags (ctx) {
  const tags = {}

  let inputs = ctx.args?.[0]
  inputs = Array.isArray(inputs) ? inputs : [inputs]

  for (const idx in inputs) {
    const input = inputs[idx]
    if (typeof input !== 'object') {
      tags[`langchain.request.inputs.${idx}`] = truncate(input)
    } else {
      for (const [key, value] of Object.entries(input)) {
        // these are mappings to the python client names, ie lc_kwargs
        // only present on BaseMessage types
        if (key.includes('lc')) continue
        tags[`langchain.request.inputs.${idx}.${key}`] = truncate(value)
      }
    }
  }

  return tags
}

function getEndTags (ctx) {
  const tags = {}

  let outputs = ctx.result
  outputs = Array.isArray(outputs) ? outputs : [outputs]

  for (const idx in outputs) {
    const output = outputs[idx]
    tags[`langchain.response.outputs.${idx}`] = truncate(output) // TODO: this might need a JSON.stringify()
  }

  return tags
}

module.exports = {
  getStartTags,
  getEndTags
}
