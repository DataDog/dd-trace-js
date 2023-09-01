'use strict'

const ALLOWED_ENV_VARIABLES = ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'PATH']
const PROCESS_DENYLIST = ['md5']
const PARAM_PATTERN = `^-{0,2}(p(?:assw(?:or)?d)?|api_?key|secret|a(?:ccess|uth)_token|mysql_pwd|credentials|stripetoken)$`
const regexParam = new RegExp(PARAM_PATTERN, 'i')
const ENV_PATTERN = '^(\\w+=\\w+;)*\\w+=\\w+;?$'
const regexEnv = new RegExp(ENV_PATTERN)
const REDACTED = '?'

function scrubChildProcessCmd (expression) {
  const result = []
  let delimPosition = 0
  const expressionList = expression.split(/;|\|{2}|\||&{2}/)

  expressionList.forEach((cmd) => {
    delimPosition += cmd.length
    const cmdSplit = cmd.trim().split(' ')

    cmdSplit.forEach((str, index) => {
      if (regexEnv.test(str) && !ALLOWED_ENV_VARIABLES.includes(str)) {
        const envSplit = str.split('=')
        envSplit[1] = REDACTED
        cmdSplit[index] = envSplit.join('=')
      } else if (PROCESS_DENYLIST.includes(str)) {
        for (let i = index + 1; i < cmdSplit.length; i++) {
          cmdSplit[i] = REDACTED
        }
      } else {
        // Check argument
        if (regexParam.test(str)) {
          cmdSplit[index + 1] = REDACTED
        }
      }
    })

    result.push(cmdSplit.join(' '))
    if (delimPosition < expression.length - 1) {
      result.push(expression.at(delimPosition))
      delimPosition += 1
    }
  })

  return result.join(' ')
}

module.exports = scrubChildProcessCmd
