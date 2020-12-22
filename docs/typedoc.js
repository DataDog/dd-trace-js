'use strict'

module.exports = {
  src: [
    '../index.d.ts',
    '../node_modules/opentracing/lib/tracer.d.ts',
  ],
  excludeExternals: true,
  excludePrivate: true,
  excludeProtected: true,
  includeDeclarations: true,
  mode: 'file',
  name: 'dd-trace',
  out: 'out',
  readme: 'API.md'
}
