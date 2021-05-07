'use strict'

const net = require('net')

const { port, reqs } = require('./common')

let connectionsMade = 0

function run () {
  const client = net.connect(port, () => {
    client.write('hello')
    client.on('data', () => {
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
