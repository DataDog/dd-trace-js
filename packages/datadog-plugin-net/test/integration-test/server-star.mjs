import 'dd-trace/init.js'
import * as net from 'net'

const client = net.createConnection(0, () => {})

client.on('data', (data) => {})

client.on('end', () => {
  client.end()
})

client.on('error', (err) => {
  client.end()
})
