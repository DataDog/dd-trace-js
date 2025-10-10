import 'dd-trace/init.js'
import net from 'net'

const client = net.createConnection(0, () => {})

client.on('data', (data) => {})

client.on('end', () => {
  client.end()
})

client.on('error', (err) => {
  client.end()
})

