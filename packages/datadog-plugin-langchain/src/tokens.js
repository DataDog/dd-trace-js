'use strict'

function getTokensFromLlmOutput (result) {
  const tokens = {
    input: 0,
    output: 0,
    total: 0
  }
  const { llmOutput } = result
  if (!llmOutput) return tokens

  const tokenUsage = llmOutput.tokenUsage || llmOutput.usage_metadata || llmOutput.usage_metadata
  if (!tokenUsage) return tokens

  for (const tokenNames of [['input', 'prompt'], ['output', 'completion'], ['total']]) {
    let token = 0
    for (const tokenName of tokenNames) {
      const underScore = `${tokenName}_tokens`
      const camelCase = `${tokenName}Tokens`

      token = tokenUsage[underScore] || tokenUsage[camelCase] || token
    }

    tokens[tokenNames[0]] = token
  }

  // assign total_tokens again in case it was improperly set the first time, or was not on tokenUsage
  tokens.total = tokens.total || tokens.input + tokens.output

  return tokens
}

module.exports = {
  getTokensFromLlmOutput
}
