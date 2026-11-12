const JasmineReporter = class {
  constructor (specs) {
    this._specs = specs
  }

  specStarted (result) {
    return result
  }

  suiteStarted (result) {
    return result
  }

  suiteDone (result) {
    return result
  }

  specDone (result) {
    return result
  }
}

const JasmineAdapter = class {
  constructor (specs) {
    this._specs = specs
  }

  async init () {
    return this
  }

  async run (error) {
    if (error) {
      throw error
    }
    return 0
  }
}

export { JasmineAdapter, JasmineReporter }
