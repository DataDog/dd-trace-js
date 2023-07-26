import 'dd-trace/init.js'
import * as pluginHelpers from './plugin-helpers.mjs'
import opensearch from '@opensearch-project/opensearch'

pluginHelpers.onMessage(async () => {
  const client = new opensearch.Client({ node: `http://localhost:9201` })
  await client.ping()
})
