import 'dd-trace/init.js'
import { createConnection } from 'net'
const net = { createConnection }

const client = net.createConnection(0, () => {})

client.on('data', (data) => {})

client.on('end', () => {
  client.end()
})

client.on('error', (err) => {
  client.end()
})

