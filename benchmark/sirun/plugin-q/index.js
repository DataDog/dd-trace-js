'use strict'

if (Number(process.env.USE_TRACER)) {
  require('../../..').init()
}

const Q = require('../../../versions/q').get()

const count = process.env.COUNT ? Number(process.env.COUNT) : 50000

const p = Q.defer()
let pChain = p.promise

for (let i = 0; i < count; i++) {
  pChain = pChain.then(() => {})
}

p.resolve()
