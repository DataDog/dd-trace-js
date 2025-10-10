import redis from 'redis'

const client = redis.createClient()

await client.connect()
await client.get('foo')
await client.quit()
