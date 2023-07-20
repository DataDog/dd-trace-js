import 'dd-trace/init.js'
import * as pluginHelpers from './plugin-helpers.mjs'
import redis from 'redis'

const client = redis.createClient()

pluginHelpers.onMessage(async () => {
  await client.connect()
  await client.get('foo')
  await client.quit()
})
