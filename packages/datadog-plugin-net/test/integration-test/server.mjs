import 'dd-trace/init.js'
import * as pluginHelpers from './plugin-helpers.mjs'
import net from 'net'
import getPort from 'get-port'

pluginHelpers.onMessage(async () => {
  const client = net.createConnection(await getPort(), () => {})
  client.on('data', (data) => {})

  client.on('end', () => {
    client.end()
  })

  client.on('error', (err) => {
    client.end()
  })
})
