'use strict'

const tracer = require('dd-trace').init()
const zlib = require('node:zlib')

const input = Buffer.from('the quick brown fox jumps over the lazy dog'.repeat(1024))

setImmediate(() => tracer.trace('x', (_, done) => {
  zlib.gzip(input, (err, gzipped) => {
    if (err) throw err
    zlib.gunzip(gzipped, (err2) => {
      if (err2) throw err2
      zlib.deflate(input, (err3) => {
        if (err3) throw err3
        zlib.brotliCompress(input, (err4) => {
          if (err4) throw err4
          done()
        })
      })
    })
  })
}))
