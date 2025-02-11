'use strict'

if (Number(process.env.USE_TRACER)) {
  require('../../..').init()
}

const Promise = require('../../../versions/bluebird/node_modules/bluebird/js/release/bluebird')

const count = process.env.COUNT ? Number(process.env.COUNT) : 50000

let resolvePromise
const p = new Promise((resolve, reject) => {
  resolvePromise = resolve
})
let pChain = p

for (let i = 0; i < count; i++) {
  pChain = pChain.then(() => {})
}

resolvePromise()
