'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../../../../../..')

function loadTracer (integration) {
  const tracer = require(path.join(ROOT, 'packages/dd-trace'))
  tracer.init({
    service: 'llmobs-parity',
    llmobs: {
      enabled: true,
      mlApp: process.env.DD_LLMOBS_ML_APP ?? 'parity',
      agentlessEnabled: false,
    },
  })
  tracer.use(integration, { llmobs: true })
  return tracer
}

function loadVersionedModule (name) {
  const versions = path.join(ROOT, 'versions')
  let parent = versions
  let prefix = `${name}@`
  if (name.startsWith('@')) {
    const [scope, packageName] = name.split('/')
    parent = path.join(versions, scope)
    prefix = `${packageName}@`
  }
  const candidates = fs.readdirSync(parent).filter(entry => entry.startsWith(prefix)).sort()
  if (candidates.length === 0) throw new Error(`missing version fixture for ${name}; run PLUGINS=${name} yarn services`)
  return require(path.join(parent, candidates[candidates.length - 1])).get()
}

async function finish (tracer) {
  await tracer.llmobs.flush()
}

module.exports = { finish, loadTracer, loadVersionedModule }
