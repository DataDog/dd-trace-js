'use strict'

// Loads one Node builtin through every view named on the command line (`cjs:url`,
// `esm:node:url`), exercises each once, and reports the result as JSON on stdout.

const { channel } = require('../../../src/helpers/instrument')

const builtins = {
  crypto: {
    channel: 'datadog:crypto:hashing:start',
    probe: 'createHash',
    exercise: (view) => view.createHash('sha256').update('a').digest('hex'),
  },
  url: {
    channel: 'datadog:url:parse:finish',
    getterChannel: 'datadog:url:getter:finish',
    probe: 'parse',
    exercise: (view) => {
      const parsed = new view.URL('https://www.datadoghq.com/path')
      parsed.host
    },
  },
  vm: {
    channel: 'datadog:vm:run-script:start',
    probe: 'runInNewContext',
    exercise: (view) => view.runInNewContext('1 + 1'),
  },
  zlib: {
    channel: 'apm:zlib:operation:start',
    probe: 'gzip',
    exercise: (view) => new Promise((resolve) => view.gzip(Buffer.from('hello'), resolve)),
  },
}

async function main () {
  const requests = process.argv.slice(2)
  const { channel: channelName, getterChannel, probe, exercise } = builtins[requests[0].split(':').at(-1)]

  let publishes = 0
  let getterPublishes = 0
  channel(channelName).subscribe(() => { publishes++ })
  if (getterChannel) channel(getterChannel).subscribe(() => { getterPublishes++ })

  const views = []
  for (const request of requests) {
    const specifier = request.slice(request.indexOf(':') + 1)
    views.push(request.startsWith('esm:') ? await import(specifier) : require(specifier))
  }

  const report = []
  for (const [index, view] of views.entries()) {
    const before = publishes
    const getterBefore = getterPublishes
    await exercise(view)
    const entry = {
      request: requests[index],
      publishes: publishes - before,
      matchesFirstView: view[probe] === views[0][probe],
    }
    if (getterChannel) entry.getterPublishes = getterPublishes - getterBefore
    if (view.default !== undefined) {
      entry.matchesOwnDefaultExport = view.default[probe] === view[probe]
    }
    report.push(entry)
  }

  // The tracer's own timers keep the process alive, so exit once stdout has drained.
  process.stdout.write(JSON.stringify(report), () => process.exit(0))
}

main()
