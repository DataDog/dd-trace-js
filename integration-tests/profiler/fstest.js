'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const tracer = require('dd-trace').init()
tracer.profilerStarted().then(() => {
  tracer.trace('x', (_, done) => {
    setImmediate(() => {
      // Generate 1MB of random data
      const buffer = Buffer.alloc(1024 * 1024)
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] = Math.floor(Math.random() * 256)
      }

      // Create a temporary file
      const tempFilePath = path.join(os.tmpdir(), 'tempfile.txt')

      fs.writeFile(tempFilePath, buffer, (err) => {
        if (err) throw err

        // Read the data back
        setImmediate(() => {
          fs.readFile(tempFilePath, (err, readData) => {
            setImmediate(() => {
              // Delete the temporary file
              fs.unlink(tempFilePath, (err) => {
                if (err) throw err
              })
              done()
            })
            if (err) throw err
            if (Buffer.compare(buffer, readData) !== 0) {
              throw new Error('Data read from file is different from data written to file')
            }
          })
        })
      })
    })
  })
})
