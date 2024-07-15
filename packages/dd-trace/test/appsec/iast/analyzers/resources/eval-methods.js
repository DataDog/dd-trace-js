'use strict'

function noop () {}

const obj = {
  eval: noop
}

module.exports = {
  runEval: (code, result) => {
    // eslint-disable-next-line no-eval
    const script = `(${code}, result)`

    return eval(script)
  },
  runFakeEval: (code, returnData) => {
    return obj.eval(`(${code}, returnData)`)
  }
}
