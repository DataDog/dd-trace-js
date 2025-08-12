'use strict'

module.exports = {
  runEval: (code, result) => {
    const script = `(${code}, result)`

    // eslint-disable-next-line no-eval
    return eval(script)
  }
}
