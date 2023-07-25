import 'dd-trace/init.js'
import * as pluginHelpers from './plugin-helpers.mjs'
import Redis from 'ioredis'

const client = new Redis()

pluginHelpers.onMessage(async () => {
  await client.connect()
  await client.get('foo')
  await client.quit()
})
