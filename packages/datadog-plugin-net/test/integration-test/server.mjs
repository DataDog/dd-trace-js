import 'dd-trace/init.js'
import net from 'net'
import getPort from 'get-port'

const port = await getPort()

const client = net.createConnection(port, () => {})

client.on('data', (data) => {})

client.on('end', () => {
  client.end()
})

client.on('error', (err) => {
  client.end()
})