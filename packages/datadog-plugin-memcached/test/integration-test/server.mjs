import 'dd-trace/init.js'
import * as pluginHelpers from './plugin-helpers.mjs'
import Memcached from 'memcached'

pluginHelpers.onMessage(async () => {
  const memcached = new Memcached('localhost:11211', { retries: 0 })
  memcached.get('test', () => {})
  memcached.end()
})
