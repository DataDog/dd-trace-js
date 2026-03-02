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
    return new FileExporter({ pprofPrefix: fileURLToPath(url) })
  }
  // TODO: Why is DD_INJECTION_ENABLED a comma separated list?
  const injectionEnabled = (getValueFromEnvSources('DD_INJECTION_ENABLED') ?? '').split(',')
  const libraryInjected = injectionEnabled.length > 0
  const profilingEnabled = (getValueFromEnvSources('DD_PROFILING_ENABLED') ?? '').toLowerCase()
  const activation = ['true', '1'].includes(profilingEnabled)
    ? 'manual'
    : profilingEnabled === 'auto'
      ? 'auto'
      : 'unknown'
  return new AgentExporter({
    url,
    logger,
    uploadTimeout: timeoutMs,
    libraryInjected,
    activation,
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
