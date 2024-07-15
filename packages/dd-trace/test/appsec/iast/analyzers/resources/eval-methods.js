'use strict'

function noop () {}

const obj = {
  eval: noop
}

module.exports = {
  runEval: (code) => {
    return eval(code)
  },
  runFakeEval: (code) => {
    return obj.eval(code)
  }
}
