'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { mkdtempSync, rmSync } = require('node:fs')
const http = require('node:http')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { promisify } = require('node:util')

const webpack = require('webpack')

const id = require('../../packages/dd-trace/src/id')
const DatadogWebpackPlugin = require('../../webpack')

const build = promisify(webpack)

async function main () {
  const directory = mkdtempSync(join(tmpdir(), 'dd-agentless-bundle-'))
  const batches = []
  const receiver = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    batches.push({ body: Buffer.concat(chunks), headers: request.headers })
    response.end()
  })

  try {
    const stats = await build({
      mode: 'development',
      devtool: false,
      target: 'node',
      entry: require.resolve('../../packages/dd-trace/src/exporters/agentless'),
      externalsType: 'commonjs',
      externals: {
        diagnostics_channel: 'diagnostics_channel',
        '@datadog/libdatadog': require.resolve('@datadog/libdatadog'),
        '@datadog/libdatadog-extras': require.resolve('@datadog/libdatadog-extras'),
      },
      output: {
        path: directory, filename: 'agentless.cjs', hashFunction: 'sha256', library: { type: 'commonjs2' },
      },
      plugins: [new DatadogWebpackPlugin()],
    })
    assert.strictEqual(stats.hasErrors(), false, stats.toString({ errors: true }))

    receiver.listen(0, '127.0.0.1')
    await once(receiver, 'listening')
    process.env.DD_API_KEY = 'test-api-key'
    const AgentlessExporter = require(join(directory, 'agentless.cjs'))
    const exporter = new AgentlessExporter({
      tags: { 'runtime-id': 'bundled-test' },
      tracing: { DD_TRACE_EXPERIMENTAL_AGENTLESS_GENERATED_OBFUSCATION_ENABLED: true },
    })
    assert.strictEqual(exporter.setUrl(`http://127.0.0.1:${receiver.address().port}`), true)
    assert.strictEqual(exporter.export([{
      name: 'sql.query',
      service: 'bundled-test',
      type: 'sql',
      resource: 'SELECT 42',
      trace_id: id('1'),
      span_id: id('1'),
      parent_id: id('0'),
      start: 1,
      duration: 1,
      error: 0,
      meta: {},
      metrics: {},
    }]), true)
    await new Promise(resolve => exporter.flush(resolve))

    assert.strictEqual(batches.length, 1)
    assert.strictEqual(batches[0].headers['content-encoding'], 'zstd')
    assert.strictEqual(batches[0].body.readUInt32LE(), 0xfd2fb528)
  } finally {
    if (receiver.listening) await new Promise(resolve => receiver.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  }
}

main()
