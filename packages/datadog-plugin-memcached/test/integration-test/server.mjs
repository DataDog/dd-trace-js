import 'dd-trace/init.js'
import Memcached from 'memcached'

const memcached = new Memcached('localhost:11211', { retries: 0 })
memcached.get('test', () => {})
memcached.end()

process.send({ port: -1 })
