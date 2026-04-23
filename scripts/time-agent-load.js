'use strict'

const { performance } = require('node:perf_hooks')
const agent = require('../packages/dd-trace/test/plugins/agent')

const originalLoad = agent.load.bind(agent)
agent.load = async function (pluginNames, ...rest) {
  const name = Array.isArray(pluginNames) ? pluginNames.join(', ') : pluginNames
  const start = performance.now()
  const result = await originalLoad(pluginNames, ...rest)
  const elapsed = performance.now() - start
  process.stdout.write(`[timing] agent.load(${name}) = ${elapsed.toFixed(1)}ms\n`)
  return result
}
