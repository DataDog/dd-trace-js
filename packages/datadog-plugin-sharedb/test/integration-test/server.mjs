import 'dd-trace/init.js'
import * as pluginHelpers from './plugin-helpers.mjs'
import ShareDB from 'sharedb'

pluginHelpers.onMessage(async () => {
  const backend = new ShareDB({ presence: true })
  const connection = backend.connect()
  await connection.get('some-collection', 'some-id').fetch()
  connection.close()
})
