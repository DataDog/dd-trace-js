'use strict'

const { AgentExporter } = require('./exporters/agent')
const { SourceMapper, heap, encode } = require('@datadog/pprof')
const { ConsoleLogger } = require('./loggers/console')
const { tagger } = require('./tagger')
const fs = require('fs')

const logger = new ConsoleLogger()

async function exportProfile (url, tags, profileType, profile) {
  let mapper
  try {
    mapper = await SourceMapper.create([process.cwd()])
  } catch (err) {
    logger.error(err)
  }

  const encodedProfile = await encode(heap.convertProfile(profile, undefined, mapper))
  const exporter = new AgentExporter({ url, logger, uploadTimeout: 10 * 1000 })
  const start = new Date()
  await exporter.export({ profiles: { [profileType]: encodedProfile }, start, end: start, tags })
}

/** Expected command line arguments are:
* - Agent URL (eg. "http://127.0.0.1:8126/")
* - Tags (eg. "service:nodejs_oom_test,version:1.0.0")
* - Profiletype (eg. space,wall,cpu)
* - JSON profile filepath
**/
exportProfile(new URL(process.argv[2]), tagger.parse(process.argv[3]),
  process.argv[4], JSON.parse(fs.readFileSync(process.argv[5])))
