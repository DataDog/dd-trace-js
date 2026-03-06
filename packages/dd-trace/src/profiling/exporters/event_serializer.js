'use strict'

/* eslint n/no-unsupported-features/node-builtins: ['error', { ignores: ['os.availableParallelism'] }] */

const os = require('os')
const perf = require('perf_hooks').performance
const version = require('../../../../../package.json').version
const { availableParallelism, libuvThreadPoolSize } = require('../libuv-size')
const processTags = require('../../process-tags')

class EventSerializer {
  #env
  #host
  #service
  #appVersion
  #libraryInjected
  #activation

  constructor ({ env, host, service, version, libraryInjected, activation } = {}) {
    this.#env = env
    this.#host = host
    this.#service = service
    this.#appVersion = version
    this.#libraryInjected = !!libraryInjected
    this.#activation = activation || 'unknown'
  }

  typeToFile (type) {
    return `${type}.pprof`
  }

  getEventJSON ({ profiles, infos, start, end, tags = {}, endpointCounts }) {
    const event = {
      attachments: Object.keys(profiles).map(t => this.typeToFile(t)),
      start: start.toISOString(),
      end: end.toISOString(),
      family: 'node',
      version: '4',
      tags_profiler: [
        'language:javascript',
        'runtime:nodejs',
        `runtime_arch:${process.arch}`,
        `runtime_os:${process.platform}`,
        `runtime_version:${process.version}`,
        `process_id:${process.pid}`,
        `profiler_version:${version}`,
        'format:pprof',
        ...Object.entries(tags).map(([key, value]) => `${key}:${value}`),
      ].join(','),
      endpoint_counts: endpointCounts,
      info: {
        application: {
          env: this.#env,
          service: this.#service,
          start_time: new Date(perf.nodeTiming.nodeStart + perf.timeOrigin).toISOString(),
          version: this.#appVersion,
        },
        platform: {
          hostname: this.#host,
          kernel_name: os.type(),
          kernel_release: os.release(),
          kernel_version: os.version(),
        },
        profiler: {
          activation: this.#activation,
          ssi: {
            mechanism: this.#libraryInjected ? 'injected_agent' : 'none',
          },
          version,
          ...infos,
        },
        runtime: {
          available_processors: availableParallelism(),
          // Using `nodejs` for consistency with the existing `runtime` tag.
          // Note that the event `family` property uses `node`, as that's what's
          // proscribed by the Intake API, but that's an internal enum and is
          // not customer visible.
          engine: 'nodejs',
          libuv_threadpool_size: libuvThreadPoolSize,
          // strip off leading 'v'. This makes the format consistent with other
          // runtimes (e.g. Ruby) but not with the existing `runtime_version` tag.
          // We'll keep it like this as we want cross-engine consistency. We
          // also aren't changing the format of the existing tag as we don't want
          // to break it.
          version: process.version.slice(1),
        },
      },
    }

    if (processTags.serialized) {
      event[processTags.PROFILING_FIELD_NAME] = processTags.serialized
    }

    return JSON.stringify(event)
  }
}

module.exports = { EventSerializer }
