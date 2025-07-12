'use strict'

function extractModel (instance) {
  const model = instance.model || instance.resourcePath || instance.publisherModelEndpoint
  return model?.split('/').pop()
}

function extractSystemInstructions (instance) {
  // systemInstruction is either a string or a Content object
  // Content objects have parts (Part[]) and a role
  const systemInstruction = instance.systemInstruction
  if (!systemInstruction) return []
  if (typeof systemInstruction === 'string') return [systemInstruction]

  return systemInstruction.parts?.map(part => part.text)
}

module.exports = {
  extractModel,
  extractSystemInstructions
}
