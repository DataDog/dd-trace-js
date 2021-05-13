'use strict'

const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

function instrument (command, ctx, args, server, ns, ops, tracer, config, options = {}) {
  const name = options.name || (ops && Object.keys(ops)[0])
  const index = args.length - 1
  const callback = args[index]

  if (typeof callback !== 'function') return command.apply(ctx, args)

  const span = startSpan(tracer, config, ns, ops, server, name)

  if (name !== 'getMore' && name !== 'killCursors') {
    analyticsSampler.sample(span, config.analytics)
  }

  args[index] = wrapCallback(tracer, span, callback)

  return tracer.scope().bind(command, span).apply(ctx, args)
}

function startSpan (tracer, config, ns, ops, server, name) {
  const scope = tracer.scope()
  const childOf = scope.active()
  const span = tracer.startSpan('mongodb.query', { childOf })

  addTags(span, tracer, config, ns, ops, server, name)

  return span
}

function wrapCallback (tracer, span, done) {
  return tracer.scope().bind((err, res) => {
    if (err) {
      span.addTags({
        'error.type': err.name,
        'error.msg': err.message,
        'error.stack': err.stack
      })
    }

    span.finish()

    if (done) {
      done(err, res)
    }
  })
}

function addTags (span, tracer, config, ns, cmd, topology, operationName) {
  const query = getQuery(cmd)
  const resource = getResource(ns, query, operationName)

  span.addTags({
    'service.name': config.service || `${tracer._service}-mongodb`,
    'resource.name': resource,
    'span.type': 'mongodb',
    'span.kind': 'client',
    'db.name': ns
  })

  if (query) {
    span.setTag('mongodb.query', query)
  }

  addHost(span, topology)
}

function addHost (span, topology) {
  const options = topology && topology.s && topology.s.options

  if (options && options.host && options.port) {
    span.addTags({
      'out.host': topology.s.options.host,
      'out.port': topology.s.options.port
    })
  }
}

function getQuery (cmd) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return
  if (cmd.query) return JSON.stringify(sanitize(cmd.query))
  if (cmd.filter) return JSON.stringify(sanitize(cmd.filter))
}

function getResource (ns, query, operationName) {
  const parts = [operationName, ns]

  if (query) {
    parts.push(query)
  }

  return parts.join(' ')
}

function sanitize (input) {
  const output = {}

  if (!isObject(input) || Buffer.isBuffer(input) || isBSON(input)) return '?'

  for (const key in input) {
    if (typeof input[key] === 'function') continue

    output[key] = sanitize(input[key])
  }

  return output
}

function isObject (val) {
  return typeof val === 'object' && val !== null && !(val instanceof Array)
}

function isBSON (val) {
  return val && val._bsontype
}

module.exports = { instrument }
