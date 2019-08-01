'use strict'

const fs = require('fs')
const { Go } = require('./go')

const go = new Go()

module.exports = {
  load () {
    return new Promise((resolve, reject) => {
      fs.readFile('./main.wasm', (err, wasm) => {
        if (err) return reject(err)

        WebAssembly.instantiate(wasm, go.importObject)
          .then(result => {
            go.run(result.instance)
            setImmediate(() => resolve())
          })
          .catch(reject)
      })
    })
  },

  obfuscate (spanData) {
    global.__dd_agent__.obfuscate(spanData)
  }
}
