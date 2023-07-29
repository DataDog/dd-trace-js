import 'dd-trace/init.js'
import Memcached from 'memcached'

const memcached = new Memcached('localhost:11211', { retries: 0 })
await memcached.get('test', () => {})
memcached.end()
