'use strict'

const tracer = require('dd-trace').init()
const crypto = require('node:crypto')

setImmediate(() => tracer.trace('x', (_, done) => {
  crypto.pbkdf2('password', 'salt', 1000, 32, 'sha256', (err) => {
    if (err) throw err
    crypto.randomBytes(16, (err2) => {
      if (err2) throw err2
      crypto.randomFill(Buffer.alloc(16), (err3) => {
        if (err3) throw err3
        done()
      })
    })
  })
}))
