'use strict'

const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { PassThrough } = require('node:stream')
const { pathToFileURL } = require('node:url')

const entry = process.env.COMPAT_ENTRY
const scenario = process.env.COMPAT_CASE
const streaming = Symbol.for('aws.lambda.runtime.handler.streaming')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main () {
  let handler
  let shimPath
  if (entry === 'npm') {
    require('dd-trace').init()
    const shim = require('datadog-lambda-js')
    const raw = require('./handler-cjs.cjs').handler
    const config = scenario === 'custom-config'
      ? {
          traceExtractor: require('./extractor.cjs').extract,
          captureLambdaPayload: true,
        }
      : undefined
    handler = shim.datadog(raw, config)
    shimPath = require.resolve('datadog-lambda-js')
  } else {
    const root = entry.startsWith('layer') ? '/opt/nodejs/node_modules' : '/var/task/node_modules'
    shimPath = `${root}/datadog-lambda-js/dist/index.js`
    handler = (await import(pathToFileURL(`${root}/datadog-lambda-js/dist/handler.mjs`))).handler
  }

  if (scenario === 'repeat-wrap') {
    const repeated = require(shimPath).datadog(handler)
    console.log(JSON.stringify({ compat: 'repeat', same: repeated === handler }))
    handler = repeated
  }

  const tracerPath = require.resolve('dd-trace')
  const shimRequire = createRequire(shimPath)
  const resolvedForShim = shimRequire.resolve('dd-trace', {
    paths: ['/var/task/node_modules', ...shimRequire.resolve.paths('dd-trace')],
  })
  assert.strictEqual(resolvedForShim, tracerPath, 'shim must resolve the candidate tracer')
  console.log(JSON.stringify({
    compat: 'identity',
    entry,
    scenario,
    node: process.version,
    tracerPath,
    shimPath,
    tracerVersion: require('dd-trace/package.json').version,
    shimVersion: require('datadog-lambda-js/package.json').version,
    gate: process.env.DD_TRACE_LAMBDA_WRAP_SHIM_HANDLERS ?? 'unset',
    streaming: handler[streaming],
  }))

  const invocations = scenario === 'warm-reject' ? 2 : 1
  for (let index = 0; index < invocations; index++) {
    const context = {
      awsRequestId: `compat-request-${index}`,
      functionName: 'legacy-lambda-compat',
      functionVersion: '$LATEST',
      memoryLimitInMB: '128',
      invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:legacy-lambda-compat',
      logGroupName: 'compat',
      logStreamName: 'compat',
      callbackWaitsForEmptyEventLoop: true,
      getRemainingTimeInMillis: () => 500,
    }
    const event = { payload: 'test' }
    if (scenario === 'propagation') {
      event.headers = {
        'x-datadog-trace-id': '1234', 'x-datadog-parent-id': '5678', 'x-datadog-sampling-priority': '1',
      }
    }
    const stream = new PassThrough()
    stream.resume()
    try {
      const promise = scenario.startsWith('stream') ? handler(event, stream, context) : handler(event, context)
      const value = scenario.startsWith('timeout')
        ? await Promise.race([promise, wait(650).then(() => 'timeout-observed')])
        : await promise
      console.log(JSON.stringify({
        compat: 'result', index, value, callbackWaits: context.callbackWaitsForEmptyEventLoop,
      }))
    } catch (error) {
      console.log(JSON.stringify({
        compat: 'result', index, error: error.message, callbackWaits: context.callbackWaitsForEmptyEventLoop,
      }))
    }
    // Beyond the 300ms timeout-monitor deadline: stale timers must not create late error spans.
    if (!scenario.startsWith('timeout')) await wait(350)
  }
}

main().then(() => process.exit(0), error => { console.error(error); process.exit(1) })
