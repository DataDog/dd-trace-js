'use strict'

const { spawn } = require('child_process')

const outputFormat = process.argv[2]

function shorten (data) {
  if (data.length < 20) return data
  return '...' + data.substring(data.length - 15)
}

function labelFor (span) {
  let label = `${span.name}\\nresource: ${span.resource}\\nservice: ${span.service}`
  for (const name in span.meta) {
    label += `\\n${name}: ${shorten(span.meta[name])}`
  }
  return label
}

function concatStream (strm, cb) {
  const bufs = []
  strm
    .on('data', data => bufs.push(data))
    .on('end', () => cb(Buffer.concat(bufs)))
}

function parseSpan (span, traces) {
  if (!traces[span.trace_id]) {
    traces[span.trace_id] = []
  }
  traces[span.trace_id].push(span)
}

concatStream(process.stdin, stdin => {
  const lines = stdin.toString('utf8').split('\n').filter(x => x).map(trace => {
    try {
      return JSON.parse(trace.replace(/^Encoding trace: /, ''))
    } catch (e) {
      return null
    }
  }).filter(x => x)

  const traces = {}

  for (const trace of lines) {
    if (!Array.isArray(trace)) {
      parseSpan(trace, traces)
    } else {
      for (const span of trace) {
        parseSpan(span, traces)
      }
    }
  }

  const dotTraces = []
  for (const traceId in traces) {
    const dotStatements = []
    const linearTrace = traces[traceId]
    for (const span of linearTrace) {
      dotStatements.push(`span_${span.span_id} [label = "${labelFor(span)}"]`)
      if (span.parent_id !== 0) {
        dotStatements.push(`span_${span.parent_id} -> span_${span.span_id}`)
      }
    }
    dotTraces.push([`subgraph trace_${traceId} {`, ...dotStatements, '}'].join('\n'))
  }
  const dotSource = `
digraph TRACES {
node [shape=record]
rankdir=LR

${dotTraces.join('\n')}
}
  `.trim()
  const dotProc = spawn('dot', [`-T${outputFormat || 'svg'}`], { stdio: ['pipe', 'inherit', 'inherit'] })
  dotProc.stdin.end(dotSource)
})
