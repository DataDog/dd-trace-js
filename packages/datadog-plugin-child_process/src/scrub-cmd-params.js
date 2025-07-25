'use strict'

const shellParser = require('shell-quote/parse')

const ALLOWED_ENV_VARIABLES = new Set(['LD_PRELOAD', 'LD_LIBRARY_PATH', 'PATH'])
const PROCESS_DENYLIST = new Set(['md5'])

const VARNAMES_REGEX = /\$([\w\d_]*)(?:[^\w\d_]|$)/gmi
// eslint-disable-next-line @stylistic/max-len
const PARAM_PATTERN = '^-{0,2}(?:p(?:ass(?:w(?:or)?d)?)?|address|api[-_]?key|e?mail|secret(?:[-_]?key)?|a(?:ccess|uth)[-_]?token|mysql_pwd|credentials|(?:stripe)?token)$'
const regexParam = new RegExp(PARAM_PATTERN, 'i')
const ENV_PATTERN = String.raw`^(\w+=\w+;)*\w+=\w+;?$`
const envVarRegex = new RegExp(ENV_PATTERN)
const REDACTED = '?'

function extractVarNames (expression) {
  const varNames = new Set()
  let match

  while ((match = VARNAMES_REGEX.exec(expression))) {
    varNames.add(match[1])
  }

  const varNamesObject = {}
  for (const varName of varNames.keys()) {
    varNamesObject[varName] = `$${varName}`
  }
  return varNamesObject
}

function getTokensByExpression (expressionTokens) {
  const expressionListTokens = []
  let wipExpressionTokens = []
  let isNewExpression = true

  expressionTokens.forEach(token => {
    if (isNewExpression) {
      expressionListTokens.push(wipExpressionTokens)
      isNewExpression = false
    }

    wipExpressionTokens.push(token)

    if (token.op) {
      wipExpressionTokens = []
      isNewExpression = true
    }
  })
  return expressionListTokens
}

function scrubChildProcessCmd (expression) {
  const varNames = extractVarNames(expression)
  const expressionTokens = shellParser(expression, varNames)

  const expressionListTokens = getTokensByExpression(expressionTokens)

  const result = []
  expressionListTokens.forEach((expressionTokens) => {
    let foundBinary = false
    for (let index = 0; index < expressionTokens.length; index++) {
      const token = expressionTokens[index]

      if (token === null) {
        continue
      } else if (typeof token === 'object') { // eslint-disable-line eslint-rules/eslint-safe-typeof-object
        if (token.pattern) {
          result.push(token.pattern)
        } else if (token.op) {
          result.push(token.op)
        } else if (token.comment) {
          result.push(`#${token.comment}`)
        }
      } else if (foundBinary) {
        const paramKeyValue = token.split('=')
        const paramKey = paramKeyValue[0]

        if (regexParam.test(paramKey)) {
          if (paramKeyValue.length === 1) {
            expressionTokens[index + 1] = REDACTED
            result.push(token)
          } else {
            result.push(`${paramKey}=${REDACTED}`)
          }
        } else {
          result.push(token)
        }
      } else {
        if (envVarRegex.test(token)) {
          const envSplit = token.split('=')

          if (ALLOWED_ENV_VARIABLES.has(envSplit[0])) {
            result.push(token)
          } else {
            envSplit[1] = REDACTED

            const newToken = envSplit.join('=')
            expressionTokens[index] = newToken

            result.push(newToken)
          }
        } else {
          foundBinary = true
          result.push(token)

          if (PROCESS_DENYLIST.has(token)) {
            for (index++; index < expressionTokens.length; index++) {
              const token = expressionTokens[index]

              if (token.op) {
                result.push(token.op)
              } else {
                expressionTokens[index] = REDACTED
                result.push(REDACTED)
              }
            }
            break
          }
        }
      }
    }
  })

  return result
}

module.exports = scrubChildProcessCmd
