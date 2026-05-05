import assert from 'node:assert/strict'

import { trace } from '@opentelemetry/api'
// @ts-expect-error
import { PrismaPg } from '@prisma/adapter-pg'
// @ts-expect-error
import ddTrace from 'dd-trace'
// @ts-expect-error
import { PrismaClient } from './dist/client.js'

const placeholderTraceparent = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01'
const zeroTraceparent = '00-00000000000000000000000000000000-0000000000000000-01'

ddTrace.init({
  dbmPropagationMode: 'full',
  plugins: false,
})
ddTrace.use('prisma', true)

const provider = new ddTrace.TracerProvider()
provider.register()

let observedTraceparent

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const prismaClient = new PrismaClient({ adapter })
const otelTracer = trace.getTracer('prisma-otel-dbm-integration')
const tracingHelper = prismaClient._tracingHelper || prismaClient._engine?.tracingHelper

assert.ok(tracingHelper && typeof tracingHelper.getTraceParent === 'function', 'Expected Prisma tracing helper')

const originalGetTraceParent = tracingHelper.getTraceParent.bind(tracingHelper)
tracingHelper.getTraceParent = function wrappedGetTraceParent (...args) {
  observedTraceparent = originalGetTraceParent(...args)
  const activeSpan = ddTrace.scope().active()
  if (activeSpan) {
    const activeContext = activeSpan.context()
    const expectedFromActiveSpan = `00-${activeContext.toTraceId(true)}-${activeContext.toSpanId(true)}-01`
    assert.strictEqual(observedTraceparent, expectedFromActiveSpan)
  }
  return observedTraceparent
}

await new Promise((resolve, reject) => {
  otelTracer.startActiveSpan('otel-parent', async (span) => {
    try {
      const spanContext = span.spanContext()
      const unique = `${Date.now()}-${process.pid}`

      await prismaClient.user.create({
        data: {
          name: 'John Doe',
          email: `john.doe+${unique}@datadoghq.com`,
        },
      })

      await prismaClient.user.findUnique({
        where: {
          email: `john.doe+${unique}@datadoghq.com`,
        },
      })

      assert.ok(observedTraceparent, 'Expected Prisma query to include traceparent comment')
      assert.ok(observedTraceparent.startsWith(`00-${spanContext.traceId}-`))
      assert.notStrictEqual(observedTraceparent, placeholderTraceparent)
      assert.notStrictEqual(observedTraceparent, zeroTraceparent)
      process.stdout.write(`TRACEPARENT_OK:${observedTraceparent}\n`)
      resolve(undefined)
    } catch (error) {
      reject(error)
    } finally {
      span.end()
    }
  })
})

await prismaClient.$disconnect()
