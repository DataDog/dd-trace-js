'use strict'

const net = require('net')

let connectionsMade = 0

function run () {
  const client = net.connect(3000, () => {
    client.write('hello')
    client.on('data', () => {
      client.end()
      if (++connectionsMade !== 10000) {
        run()
      }
    })
  })
}
run()
