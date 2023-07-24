import 'dd-trace/init.js'
import * as pluginHelpers from './plugin-helpers.mjs'
import { Client } from '@elastic/elasticsearch'

pluginHelpers.onMessage(async () => {
  const client = new Client({ node: 'http://localhost:9200' })
  await client.ping()
})
