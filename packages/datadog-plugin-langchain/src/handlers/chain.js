'use strict'

const { truncate } = require('../util')

function getStartTags (ctx) {
  const tags = {}

  let inputs = ctx.args?.[0]
  inputs = Array.isArray(inputs) ? inputs : [inputs]

  for (const idx in inputs) {
    const input = inputs[idx]
    if (typeof input === 'string') {
      tags[`langchain.request.inputs.${idx}`] = input
    } else {
      const content = input.content
      const role = input.role || input.constructor.name
      tags[`langchain.request.inputs.${idx}.role`] = role
      tags[`langchain.request.inputs.${idx}.content`] = truncate(content)
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
