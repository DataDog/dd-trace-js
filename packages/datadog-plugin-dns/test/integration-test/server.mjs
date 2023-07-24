import 'dd-trace/init.js'
import * as pluginHelpers from './plugin-helpers.mjs'
import dns from 'dns'

pluginHelpers.onMessage(async () => {
  dns.lookup('fakedomain.faketld', { all: true }, (err, address, family) => {})
})
