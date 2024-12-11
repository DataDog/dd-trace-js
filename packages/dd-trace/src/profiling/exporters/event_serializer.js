const os = require('os')
const perf = require('perf_hooks').performance
const version = require('../../../../../package.json').version

class EventSerializer {
  constructor ({ env, host, service, version, libraryInjected, activation } = {}) {
    this._env = env
    this._host = host
    this._service = service
    this._appVersion = version
    this._libraryInjected = !!libraryInjected
    this._activation = activation || 'unknown'
  }

  typeToFile (type) {
    return `${type}.pprof`
  }

  getEventJSON ({ profiles, start, end, tags = {}, endpointCounts }) {
    return JSON.stringify({
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
        ...Object.entries(tags).map(([key, value]) => `${key}:${value}`)
      ].join(','),
      endpoint_counts: endpointCounts,
      info: {
        application: {
          env: this._env,
          service: this._service,
          start_time: new Date(perf.nodeTiming.nodeStart + perf.timeOrigin).toISOString(),
          version: this._appVersion
        },
        platform: {
          hostname: this._host,
          kernel_name: os.type(),
          kernel_release: os.release(),
          kernel_version: os.version()
        },
        profiler: {
          activation: this._activation,
          ssi: {
            mechanism: this._libraryInjected ? 'injected_agent' : 'none'
          },
          version
        },
        runtime: {
          // Using `nodejs` for consistency with the existing `runtime` tag.
          // Note that the event `family` property uses `node`, as that's what's
          // proscribed by the Intake API, but that's an internal enum and is
          // not customer visible.
          engine: 'nodejs',
          // strip off leading 'v'. This makes the format consistent with other
          // runtimes (e.g. Ruby) but not with the existing `runtime_version` tag.
          // We'll keep it like this as we want cross-engine consistency. We
          // also aren't changing the format of the existing tag as we don't want
          // to break it.
          version: process.version.substring(1)
        }
      }
    })
  }
}

module.exports = { EventSerializer }
