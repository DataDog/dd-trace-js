'use strict'

const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { join } = require('node:path')

const scenario = JSON.parse(process.argv[2])
const requireDependency = createRequire(join(__dirname, 'dependency/package.json'))
const requireTracer = createRequire(require.resolve('dd-trace/package.json'))
const logger = { debug () {}, info () {}, warn () {}, error () {}, verbose () {} }
const hiddenOwner = scenario.hiddenRegistry ? requireDependency('@opentelemetry/api') : undefined
if (hiddenOwner) hiddenOwner.diag.setLogger(logger)
const cached = scenario.order === 'cached-api-first' ? require('@opentelemetry/api') : undefined
const tracer = scenario.native
  ? undefined
  : require('dd-trace').init({
    plugins: false,
    runtimeMetrics: false,
    otelApiPath: scenario.owner && !scenario.ownerEnv
      ? requireDependency.resolve('@opentelemetry/api')
      : undefined,
  })
const apis = {
  application: scenario.application ? require('@opentelemetry/api') : undefined,
  private: scenario.privateApi ? requireTracer('@opentelemetry/api') : undefined,
  dependency: hiddenOwner ?? (
    scenario.order === 'dependency-late' ? undefined : requireDependency('@opentelemetry/api')
  ),
}
const ended = []
const processors = [{
  onStart () {},
  /** @param {import('@opentelemetry/sdk-trace-base').ReadableSpan} span */
  onEnd (span) { ended.push(span) },
  shutdown () {},
  forceFlush () {},
}]
let bridge = scenario.order === 'bridge-first'
  ? new tracer.TracerProvider({ spanProcessors: processors })
  : undefined
const registryKey = Symbol.for('opentelemetry.js.api.1')

if (scenario.registry) apis[scenario.registry].diag.setLogger(logger)
if (scenario.active !== false && tracer) {
  bridge ??= new tracer.TracerProvider({ spanProcessors: processors })
  if (scenario.signal === 'metrics') bridge.register()
}
if (!apis.dependency) apis.dependency = requireDependency('@opentelemetry/api')
const source = apis[scenario.writer]
const consumers = Object.values(apis).filter(Boolean)
const registryBefore = globalThis[registryKey]

async function main () {
  try {
    if (scenario.afterWrite) {
      let armed = false
      const error = new Error('native post-registration diagnostic')
      source.diag.setLogger({ ...logger, debug () { if (armed) throw error } }, source.DiagLogLevel.ALL)
      armed = true
      const { MeterProvider } = require('@opentelemetry/sdk-metrics')
      const { BasicTracerProvider } = require('@opentelemetry/sdk-trace-base')
      const provider = scenario.signal === 'metrics' ? new MeterProvider() : new BasicTracerProvider()
      const proxy = source.trace.getTracerProvider()
      const early = source.trace.getTracer('before-write')
      const method = scenario.signal === 'metrics' ? 'setGlobalMeterProvider' : 'setGlobalTracerProvider'
      try {
        assert.throws(() => source[scenario.signal][method](provider), value => value === error)
        assert.equal(globalThis[registryKey][scenario.signal], scenario.signal === 'metrics' ? provider : proxy)
        assert.equal(source[scenario.signal][method](provider), false)
        if (scenario.signal === 'trace') {
          const span = early.startSpan('unbound')
          assert.equal(span.isRecording(), false)
          const direct = provider.getTracer('direct').startSpan('recording')
          assert.equal(direct.isRecording(), true)
          direct.end()
        }
      } finally {
        await provider.shutdown()
      }
      return
    }
    if (scenario.argument) {
      const values = {
        undefined, null: null, false: false, zero: 0, empty: '', nan: NaN, string: 'invalid', true: true,
      }
      const methods = {
        metrics: 'setGlobalMeterProvider',
        trace: 'setGlobalTracerProvider',
        context: 'setGlobalContextManager',
        propagation: 'setGlobalPropagator',
      }
      const registered = scenario.argument === 'absent'
        ? source[scenario.signal][methods[scenario.signal]]()
        : source[scenario.signal][methods[scenario.signal]](values[scenario.argument])
      assert.equal(registered, false)
      assert.equal(globalThis[registryKey][scenario.signal], undefined)
      return
    }
    if (scenario.signal === 'metrics') {
      const { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } =
        require('@opentelemetry/sdk-metrics')
      const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
      const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })
      const provider = new MeterProvider({ readers: [reader] })
      let existing
      try {
        if (scenario.duplicate) {
          existing = new MeterProvider({ readers: [] })
          assert.equal(apis[scenario.registry].metrics.setGlobalMeterProvider(existing), true)
        }
        if (scenario.throw) {
          const error = new Error('native registration diagnostic')
          apis[scenario.registry].diag.setLogger({ ...logger, error () { throw error } })
          assert.throws(() => source.metrics.setGlobalMeterProvider(provider), value => value === error)
          assert.equal(globalThis[registryKey].metrics, existing)
          return
        }
        const registered = source.metrics.setGlobalMeterProvider(provider)
        assert.equal(registered, scenario.registered)
        assert.equal(globalThis[registryKey].version, scenario.version)
        assert.equal(globalThis[registryKey].metrics, scenario.duplicate ? existing : registered ? provider : undefined)
        for (let index = 0; index < consumers.length; index++) {
          consumers[index].metrics.getMeter('consumer').createCounter('counter_' + index).add(1)
        }
        const { resourceMetrics } = await reader.collect()
        const values = new Map(resourceMetrics.scopeMetrics.flatMap(scope => scope.metrics)
          .map(metric => [metric.descriptor.name, metric.dataPoints.reduce((sum, point) => sum + point.value, 0)]))
        for (let index = 0; index < consumers.length; index++) {
          assert.equal(values.get('counter_' + index) ?? 0, scenario.counts[index])
        }
      } finally {
        await Promise.all([provider.shutdown(), existing?.shutdown()])
      }
    } else if (scenario.signal === 'trace') {
      const early = consumers.map(api => api.trace.getTracer('early'))
      if (scenario.registerBridge) {
        bridge.register()
      } else {
        assert.equal(source.trace.setGlobalTracerProvider(bridge), scenario.registered)
      }
      assert.equal(globalThis[registryKey].version, scenario.version)
      for (const [index, otelTracer] of early.entries()) {
        const span = otelTracer.startSpan('registration')
        const recording = scenario.recording?.[index] ?? true
        assert.equal(span.isRecording(), recording)
        span.end()
        if (recording) assert.equal(ended.at(-1).spanContext().spanId, span.spanContext().spanId)
      }
      if (cached) {
        const span = cached.trace.getTracer('cached').startSpan('cached')
        assert.equal(span.isRecording(), true)
        span.end()
      }
    } else if (scenario.signal === 'context') {
      const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks')
      const manager = new AsyncLocalStorageContextManager().enable()
      try {
        assert.equal(source.context.setGlobalContextManager(manager), scenario.registered)
        assert.equal(globalThis[registryKey].context, manager)
        const key = source.createContextKey('registration')
        const context = source.ROOT_CONTEXT.setValue(key, 'registered')
        for (const api of consumers) {
          api.context.with(context, () => assert.equal(api.context.active().getValue(key), 'registered'))
        }
      } finally {
        manager.disable()
      }
    } else if (scenario.signal === 'propagation') {
      const key = source.createContextKey('registration')
      const propagator = {
        /**
         * @param {import('@opentelemetry/api').Context} context
         * @param {Record<string, string>} carrier
         * @param {import('@opentelemetry/api').TextMapSetter} setter
         */
        inject (context, carrier, setter) { setter.set(carrier, 'registration', context.getValue(key)) },
        /**
         * @param {import('@opentelemetry/api').Context} context
         * @param {Record<string, string>} carrier
         * @param {import('@opentelemetry/api').TextMapGetter} getter
         */
        extract (context, carrier, getter) { return context.setValue(key, getter.get(carrier, 'registration')) },
        fields () { return ['registration'] },
      }
      assert.equal(source.propagation.setGlobalPropagator(propagator), scenario.registered)
      assert.equal(globalThis[registryKey].propagation, propagator)
      for (const api of consumers) {
        const carrier = {}
        api.propagation.inject(source.ROOT_CONTEXT.setValue(key, 'registered'), carrier)
        assert.equal(carrier.registration, 'registered')
        assert.equal(api.propagation.extract(api.ROOT_CONTEXT, carrier).getValue(key), 'registered')
      }
    }
  } finally {
    if (registryBefore) assert.equal(globalThis[registryKey], registryBefore)
  }
}

main().catch(error => {
  process.stderr.write((error.stack ?? String(error)) + '\n')
  process.exitCode = 1
})
