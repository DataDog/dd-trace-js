'use strict'

const shellParser = require('shell-quote/parse')

const ALLOWED_ENV_VARIABLES = ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'PATH']
const PROCESS_DENYLIST = ['md5']

const VARNAMES_REGEX = /\$([\w\d_]*)(?:[^\w\d_]|$)/gmi
// eslint-disable-next-line max-len
const PARAM_PATTERN = '^-{0,2}(?:p(?:ass(?:w(?:or)?d)?)?|api_?key|secret|(?:a(?:ccess|uth)_)?token|mysql_pwd|credentials|stripetoken)$'
const regexParam = new RegExp(PARAM_PATTERN, 'i')
const ENV_PATTERN = '^(\\w+=\\w+;)*\\w+=\\w+;?$'
const regexEnv = new RegExp(ENV_PATTERN)
const REDACTED = '?'

function extractVarNames (expression) {
  const varnames = new Set()
  let match = VARNAMES_REGEX.exec(expression)
  while (match) {
    varnames.add(match[1])
    match = VARNAMES_REGEX.exec(expression)
  }
  return varnames
}

function scrubChildProcessCmd (expression) {
  const varNames = extractVarNames(expression)
  const varNamesObject = {}
  for (const varName of varNames.keys()) {
    varNamesObject[varName] = `$${varName}`
  }
  const expressionTokens = shellParser(expression, varNamesObject)
  const expressionListTokens = []

  let wipExpressionTokens = []
  let isNew = true
  expressionTokens.forEach(token => {
    if (isNew) {
      expressionListTokens.push(wipExpressionTokens)
      isNew = false
    }
    wipExpressionTokens.push(token)
    if (token.op) {
      wipExpressionTokens = []
      isNew = true
    }
  })

  const result = []
  expressionListTokens.forEach((expressionTokens) => {
    let foundBinary = false
    for (let index = 0; index < expressionTokens.length; index++) {
      const str = expressionTokens[index]
      if (str.op) {
        result.push(str.op)
      } else if (!foundBinary) {
        if (regexEnv.test(str)) {
          const envSplit = str.split('=')
          if (!ALLOWED_ENV_VARIABLES.includes(envSplit[0])) {
            envSplit[1] = REDACTED
            const newStr = envSplit.join('=')
            expressionTokens[index] = newStr
            result.push(newStr)
          } else {
            result.push(str)
          }
        } else {
          foundBinary = true
          result.push(str)
          if (PROCESS_DENYLIST.includes(str)) {
            for (index++; index < expressionTokens.length; index++) {
              const token = expressionTokens[index]
              if (token.op) {
                result.push(token.op)
                break
              }
              expressionTokens[index] = REDACTED
              result.push(REDACTED)
            }
            break
          }
        }
      } else {
        // Check argument
        const paramKeyValue = str.split('=')
        const paramKey = paramKeyValue[0]
        if (regexParam.test(paramKey)) {
          if (paramKeyValue.length === 1) {
            expressionTokens[index + 1] = REDACTED
            result.push(str)
          } else {
            result.push(`${paramKey}=${REDACTED}`)
          }
        } else {
          result.push(str)
        }
      }
    }
  })

  return result
}

module.exports = scrubChildProcessCmd
