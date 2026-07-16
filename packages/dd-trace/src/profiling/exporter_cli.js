'use strict'

const fs = require('fs')
const { fileURLToPath } = require('url')
const { SourceMapper, heap, encode } = require('@datadog/pprof')
const { getValueFromEnvSources } = require('../config/helper')
const { AgentExporter } = require('./exporters/agent')
const { FileExporter } = require('./exporters/file')

const { ConsoleLogger } = require('./loggers/console')
const { tagger } = require('./tagger')

const logger = new ConsoleLogger()
const timeoutMs = 15 * 1000

function exporterFromURL (url) {
  if (url.protocol === 'file:') {
    return new FileExporter({}, fileURLToPath(url))
  }
  // The subprocess has no tracer config, so mirror the canonical config property
  // names the exporters read. Normalize the raw env to the parsed profiling.DD_PROFILING_ENABLED
  // values ('true' | 'false' | 'auto') the main process would have produced.
  const profilingEnabled = (getValueFromEnvSources('DD_PROFILING_ENABLED') ?? '').toLowerCase()
  const enabled = profilingEnabled === 'auto'
    ? 'auto'
    : ['true', '1'].includes(profilingEnabled) ? 'true' : 'false'
  return new AgentExporter({
    url,
    DD_PROFILING_UPLOAD_TIMEOUT: timeoutMs,
    DD_INJECTION_ENABLED: getValueFromEnvSources('DD_INJECTION_ENABLED'),
    profiling: { DD_PROFILING_ENABLED: enabled },
  })
}

async function exportProfile (urls, tags, profileType, profile) {
  let mapper
  try {
    mapper = await SourceMapper.create([process.cwd()])
  } catch (err) {
    logger.error(err)
  }

  const encodedProfile = await encode(heap.convertProfile(profile, undefined, mapper))
  const start = new Date()
  await Promise.all(urls.map(async (url) => {
    const exporter = exporterFromURL(url)

    await exporter.export({
      profiles: {
        [profileType]: encodedProfile,
      },
      start,
      end: start,
      tags,
    })
  }))
}

/**
 * Expected command line arguments are:
 * - Comma separated list of URLs (eg. "http://127.0.0.1:8126/,file:///tmp/foo.pprof")
 * - Tags (eg. "service:nodejs_oom_test,version:1.0.0")
 * - Profile type (eg. space,wall,cpu)
 * - JSON profile filepath
 */
const urls = process.argv[2].split(',').map(s => new URL(s))
const tags = tagger.parse(process.argv[3])
const profileType = process.argv[4]
const profile = JSON.parse(fs.readFileSync(process.argv[5], 'utf8'))

exportProfile(urls, tags, profileType, profile)
