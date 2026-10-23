'use strict'

const assert = require('node:assert/strict')
const { resolve } = require('node:path')

const root = resolve(__dirname, '../../../../../../..')
const tracer = require(root).init({
  startupLogs: false,
  apmTracingEnabled: false,
  llmobs: { mlApp: 'service-disable-test', agentlessEnabled: false },
})
tracer.use('aws-sdk', { bedrockruntime: { enabled: true } })
const dc = require('dc-polyfill')
const AWS = require(`${root}/versions/@aws-sdk/client-bedrock-runtime@${process.argv[2]}`).get()
const { event } = require(`${root}/packages/datadog-instrumentations/test/nova-sonic/helpers`)

async function main () {
  assert.equal(process.env.DD_TRACE_AWS_SDK_BEDROCKRUNTIME_ENABLED, 'false')
  const capture = dc.channel('dd-trace:aws:bedrockruntime:sonic:capture-context')
  assert.equal(capture.hasSubscribers, false)
  assert.equal(dc.channel('apm:aws:request:start:s3').hasSubscribers, true)
  const context = {}
  capture.publish(context)
  assert.equal(context.enabled, undefined)
  let spans = 0
  const onSpan = () => { spans++ }
  const start = dc.channel('tracing:apm:aws:bedrockruntime:sonic:span:start')
  start.subscribe(onSpan)
  const client = new AWS.BedrockRuntimeClient({
    region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, cacheMiddleware: true,
  })
  const values = [event('audioInput', { contentName: 'mic', content: 'AAAA' })]
  const body = { async * [Symbol.asyncIterator] () { yield * values } }
  const input = { modelId: 'amazon.nova-2-sonic-v1:0', body }
  const request = new AWS.InvokeModelWithBidirectionalStreamCommand(input)
  request.middlewareStack.add(() => async args => {
    assert.equal(args.input, input)
    assert.equal(args.input.body, body)
    const received = []
    for await (const value of args.input.body) received.push(value)
    assert.deepEqual(received, values)
    return { output: { body, $metadata: {} } }
  }, { name: 'fixtureTransport', step: 'initialize', priority: 'high' })
  try {
    for (let i = 0; i < 2; i++) {
      const output = await client.send(request)
      assert.equal(output.body, body)
      const received = []
      for await (const value of output.body) received.push(value)
      assert.deepEqual(received, values)
      assert.equal(request.input, input)
    }
    assert.equal(spans, 0)
  } finally {
    start.unsubscribe(onSpan)
    client.destroy()
  }
}

main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1 })
