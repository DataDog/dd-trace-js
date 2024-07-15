'use strict'

function noop () {}

const obj = {
  eval: noop
}

module.exports = {
  runEval: (code, result) => {
    const script = `(${code}, result)`

    // eslint-disable-next-line no-eval
    return eval(script)
  },
  runFakeEval: (code, returnData) => {
    return obj.eval(`(${code}, returnData)`)
  }
}
