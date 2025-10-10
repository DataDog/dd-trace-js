import 'dd-trace/init.js'
import elasticsearch from '@elastic/elasticsearch'

const client = new elasticsearch.Client({ node: 'http://127.0.0.1:9200' })

await client.ping()

