'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class FsPlugin extends TracingPlugin {
  static get id () { return 'fs' }
  static get operation () { return 'operation' }

  configure (...args) {
    return super.configure(...args)
  }

  start ({ operation, ...params }) {
    if (!this.activeSpan) return this.skip()

    const lowerOp = operation.toLowerCase()
    const flag = params.flag || params.flags || (params.options && (params.options.flag || params.options.flags))
    const defaultFlag = ((lowerOp.includes('open') || lowerOp.includes('read')) && 'r') ||
      (lowerOp.includes('write') && 'w') ||
      (lowerOp.includes('append') && 'a')
    const fd = params.fd || (typeof params.file === 'number' && params.file)
    const path = params.path || params.prefix || params.filename || (typeof params.file === 'string' && params.file)
    const uid = typeof params.uid === 'number' && params.uid.toString()
    const gid = typeof params.gid === 'number' && params.gid.toString()
    const mode = typeof params.mode === 'number' ? params.mode.toString(8) : params.mode

    this.startSpan('fs.operation', {
      service: this.config.service,
      resource: operation,
      kind: 'internal',
      meta: {
        'file.descriptor': (typeof fd === 'object' || typeof fd === 'number') ? fd.toString() : '',
        'file.dest': params.dest || params.newPath || (params.target && params.path),
        'file.flag': String(flag || defaultFlag || ''),
        'file.gid': gid || '',
        'file.mode': mode,
        'file.path': path || '',
        'file.src': params.src || params.oldPath || params.existingPath || params.target,
        'file.uid': uid || ''
      }
    })
  }
}

module.exports = FsPlugin
