const EventPlugin = require('./event')

// Values taken from parameter names in datadog-instrumentations/src/fs.js.
// Known param names that are disallowed because they can be strings and have arbitrary sizes:
// 'data'
// Known param names that are disallowed because they are never a string or number:
// 'buffer', 'buffers', 'listener'
const allowedParams = new Set([
  'atime', 'dest',
  'existingPath', 'fd', 'file',
  'flag', 'gid', 'len',
  'length', 'mode', 'mtime',
  'newPath', 'offset', 'oldPath',
  'operation', 'options', 'path',
  'position', 'prefix', 'src',
  'target', 'type', 'uid'
])

class FilesystemPlugin extends EventPlugin {
  static get id () {
    return 'fs'
  }

  static get operation () {
    return 'operation'
  }

  static get entryType () {
    return 'fs'
  }

  ignoreEvent (event) {
    // Don't care about sync events, they show up in the event loop samples anyway
    return event.operation?.endsWith('Sync')
  }

  extendEvent (event, detail) {
    const d = { ...detail }
    Object.entries(d).forEach(([k, v]) => {
      if (!(allowedParams.has(k) && (typeof v === 'string' || typeof v === 'number'))) {
        delete d[k]
      }
    })
    event.detail = d

    return event
  }
}
module.exports = FilesystemPlugin
