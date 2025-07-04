'use strict'

const net = require('net')

async function streamToString (stream) {
  const chunks = []

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk))
  }

  return Buffer.concat(chunks).toString('utf8')
}

const port1 = Number(process.argv[2])
const port2 = Number(process.argv[3])
const msg = process.argv[4]

async function oneTimeConnect (hostSpec) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(hostSpec, async () => {
      const resp = await streamToString(socket)
      if (resp !== msg) {
        reject(new Error(`Expected response ${msg}, got ${resp} instead.`))
      } else {
        resolve()
      }
    })
  })
}

require('dd-trace').init().profilerStarted()
  .then(() => {
    oneTimeConnect({ host: '127.0.0.1', port: port1 })
  }).then(() => {
    oneTimeConnect({ host: '127.0.0.1', port: port2 })
  })
