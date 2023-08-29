import 'dd-trace/init.js'
import { Client } from '@elastic/elasticsearch'

const client = new Client({ node: 'http://localhost:9200' })

await client.ping()