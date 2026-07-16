'use strict'

const assert = require('node:assert/strict')
const net = require('net')

const { port, reqs } = require('./common')

let connectionsMade = 0
let checked = false

function run () {
  const client = net.connect(port, () => {
    client.write('hello')
    client.on('data', (data) => {
      if (!checked) {
        // Fail loudly if the echo round-trip is broken.
        assert.equal(data.toString(), 'hello', 'echo server did not return the payload')
        checked = true
      }
      client.end(() => {
        if (++connectionsMade !== reqs) {
          run()
        }
      })
    })
  }).on('error', () => {
    setTimeout(run, 100)
  })
}
run()
