'use strict'

/**
 * Agentless Exporter Stress Test
 *
 * Run with:
 *   DD_API_KEY=<your-key> node scripts/agentless-stress-test.js
 *
 * Optional environment variables:
 *   DD_SITE - Datadog site (default: datadoghq.com)
 *   DD_ENV - Environment name (default: agentless-stress-test)
 *   DD_SERVICE - Service name (default: agentless-stress-test)
 *   DD_TRACE_DEBUG - Enable debug logging (default: false)
 */

if (!process.env.DD_API_KEY) {
  console.error('ERROR: DD_API_KEY environment variable is required')
  process.exit(1)
}

process.env._DD_APM_TRACING_AGENTLESS_ENABLED = 'true'
process.env.DD_TRACE_DEBUG = process.env.DD_TRACE_DEBUG || 'false'
process.env.DD_ENV = process.env.DD_ENV || 'agentless-stress-test'
process.env.DD_SERVICE = process.env.DD_SERVICE || 'agentless-stress-test'
process.env.DD_TRACE_FLUSH_INTERVAL = '2000'

const tracer = require('../packages/dd-trace').init()

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function run () {
  console.log('\n=== Agentless Exporter Stress Test ===')
  console.log(`Site: ${process.env.DD_SITE || 'datadoghq.com'}`)
  console.log(`Environment: ${process.env.DD_ENV}`)
  console.log(`Service: ${process.env.DD_SERVICE}\n`)

  let totalSpans = 0

  // Scenario 1: Simple spans (10)
  console.log('[Simple Spans] Creating 10 basic spans...')
  for (let i = 0; i < 10; i++) {
    tracer.trace('simple.operation', { resource: `simple_${i}` }, (span) => {
      span.setTag('iteration', i)
      span.setTag('type', 'simple')
    })
    totalSpans++
  }

  // Scenario 2: Nested spans (15)
  console.log('[Nested Spans] Creating 5 traces with 3-level hierarchy...')
  for (let i = 0; i < 5; i++) {
    tracer.trace('parent.operation', { resource: `parent_${i}` }, () => {
      tracer.trace('child.operation', { resource: `child_${i}` }, () => {
        tracer.trace('grandchild.operation', { resource: `grandchild_${i}` }, () => {})
      })
    })
    totalSpans += 3
  }

  // Scenario 3: Error spans (5)
  console.log('[Error Spans] Creating 5 error spans...')
  const errorTypes = ['ValidationError', 'NetworkError', 'DatabaseError', 'AuthError', 'PermissionError']
  for (const errType of errorTypes) {
    tracer.trace('error.operation', { resource: `error_${errType}` }, (span) => {
      span.setTag('error', true)
      span.setTag('error.type', errType)
      span.setTag('error.message', `${errType}: Something went wrong`)
    })
    totalSpans++
  }

  // Scenario 4: Rich metadata spans (5)
  console.log('[Rich Metadata] Creating 5 spans with HTTP/DB tags...')
  for (let i = 0; i < 5; i++) {
    tracer.trace('metadata.operation', { resource: `rich_metadata_${i}` }, (span) => {
      span.setTag('http.method', ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'][i])
      span.setTag('http.url', `https://api.example.com/users/${i}`)
      span.setTag('http.status_code', [200, 201, 400, 404, 500][i])
      span.setTag('db.type', 'postgresql')
      span.setTag('db.statement', `SELECT * FROM users WHERE id = ${i}`)
    })
    totalSpans++
  }

  // Scenario 5: Unicode and special characters (7)
  console.log('[Unicode] Creating 7 spans with international text...')
  const unicodeTexts = [
    { lang: 'japanese', text: 'こんにちは世界' },
    { lang: 'chinese', text: '你好世界' },
    { lang: 'korean', text: '안녕하세요' },
    { lang: 'russian', text: 'Привет мир' },
    { lang: 'arabic', text: 'مرحبا' },
    { lang: 'emoji', text: '🚀 🎉 ✨ 💻' },
    { lang: 'special', text: '<>&"\'chars' }
  ]
  for (const item of unicodeTexts) {
    tracer.trace('unicode.operation', { resource: `unicode_${item.lang}` }, (span) => {
      span.setTag('language', item.lang)
      span.setTag('message', item.text)
    })
    totalSpans++
  }

  // Scenario 6: Large string values (4)
  console.log('[Large Strings] Creating 4 spans with large tag values...')
  const sizes = [100, 1000, 5000, 10000]
  for (const size of sizes) {
    tracer.trace('large.string.operation', { resource: `string_size_${size}` }, (span) => {
      span.setTag('large_value', 'x'.repeat(size))
      span.setTag('string_size', size)
    })
    totalSpans++
  }

  // Scenario 7: High volume burst (100)
  console.log('[Burst] Creating 100 spans in rapid succession...')
  for (let i = 0; i < 100; i++) {
    tracer.trace('burst.operation', { resource: `burst_${i}` }, (span) => {
      span.setTag('batch', 'high_volume')
      span.setTag('index', i)
    })
    totalSpans++
  }

  // Scenario 8: Different span types (10)
  console.log('[Span Types] Creating 10 spans with different types...')
  const types = ['web', 'db', 'cache', 'http', 'sql', 'redis', 'grpc', 'graphql', 'queue', 'custom']
  for (const type of types) {
    tracer.trace(`${type}.operation`, { resource: `type_${type}`, type }, (span) => {
      span.setTag('span.type', type)
    })
    totalSpans++
  }

  // Scenario 9: Concurrent traces (20)
  console.log('[Concurrent] Creating 10 overlapping traces (20 spans)...')
  const promises = []
  for (let i = 0; i < 10; i++) {
    promises.push(new Promise(resolve => {
      tracer.trace('concurrent.operation', { resource: `concurrent_${i}` }, async (span) => {
        span.setTag('concurrency_index', i)
        tracer.trace('concurrent.child', { resource: `concurrent_child_${i}` }, async () => {
          await sleep(Math.random() * 100)
          resolve()
        })
      })
    }))
    totalSpans += 2
  }
  await Promise.all(promises)

  // Scenario 10: Resource name variations (10)
  console.log('[Resources] Creating 10 spans with varied resource names...')
  const resources = [
    'GET /api/users',
    'POST /api/users/:id',
    'SELECT * FROM users',
    'HGET user:session',
    'kafka.consume',
    'grpc.MyService/GetUser',
    'graphql.query',
    'lambda.invoke',
    'sqs.SendMessage',
    'dynamodb.PutItem'
  ]
  for (const resource of resources) {
    tracer.trace('resource.operation', { resource }, (span) => {
      span.setTag('resource.pattern', resource)
    })
    totalSpans++
  }

  // Scenario 11: Numeric metrics (5)
  console.log('[Metrics] Creating 5 spans with numeric metrics...')
  for (let i = 0; i < 5; i++) {
    tracer.trace('metrics.operation', { resource: `metrics_${i}` }, (span) => {
      span.setTag('count', Math.floor(Math.random() * 1000))
      span.setTag('latency_ms', Math.random() * 500)
      span.setTag('memory_mb', Math.random() * 1024)
    })
    totalSpans++
  }

  console.log(`\n=== Created ${totalSpans} spans ===`)
  console.log('Waiting 60 seconds for sequential flush to complete...\n')

  await sleep(60000)

  console.log('=== Stress Test Complete ===\n')
  console.log('Validate in Datadog UI:')
  console.log(`  1. Navigate to APM > Traces`)
  console.log(`  2. Filter by: env:${process.env.DD_ENV}`)
  console.log(`  3. Expected: ${totalSpans} spans\n`)
  console.log('Checklist:')
  console.log('  [ ] Simple spans appear with iteration tags')
  console.log('  [ ] Nested spans show parent-child hierarchy')
  console.log('  [ ] Error spans have error flag and error.* tags')
  console.log('  [ ] Rich metadata spans contain HTTP/DB tags')
  console.log('  [ ] Unicode characters render correctly')
  console.log('  [ ] Large string values present (may be truncated)')
  console.log('  [ ] Burst spans all appear (100 total)')
  console.log('  [ ] Different span types categorized correctly')
  console.log('  [ ] Concurrent traces show overlapping timelines')
  console.log('  [ ] Resource names display correctly')
  console.log('  [ ] Numeric metrics in span metadata')

  process.exit(0)
}

run().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
