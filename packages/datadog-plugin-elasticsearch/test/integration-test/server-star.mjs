import 'dd-trace/init.js'
import * as modelasticsearch from '@elastic/elasticsearch'
const elasticsearch = modelasticsearch.default

const client = new elasticsearch.Client({ node: 'http://127.0.0.1:9200' })

await client.ping()

