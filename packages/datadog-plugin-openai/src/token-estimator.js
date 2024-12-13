'use strict'

// If model is unavailable or tiktoken is not imported, then provide a very rough estimate of the number of tokens
// Approximate using the following assumptions:
//    * English text
//    * 1 token ~= 4 chars
//    * 1 token ~= ¾ words
module.exports.estimateTokens = function (content) {
  let estimatedTokens = 0
  if (typeof content === 'string') {
    const estimation1 = content.length / 4

    const matches = content.match(/[\w']+|[.,!?;~@#$%^&*()+/-]/g)
    const estimation2 = matches ? matches.length * 0.75 : 0 // in the case of an empty string
    estimatedTokens = Math.round((1.5 * estimation1 + 0.5 * estimation2) / 2)
  } else if (Array.isArray(content) && typeof content[0] === 'number') {
    estimatedTokens = content.length
  }
  return estimatedTokens
}
