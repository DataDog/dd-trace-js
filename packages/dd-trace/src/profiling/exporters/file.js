'use strict'

const fs = require('fs')
const { promisify } = require('util')
const { threadId } = require('worker_threads')
const writeFile = promisify(fs.writeFile)
const { EventSerializer } = require('./event_serializer')

function formatDateTime (t) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}` +
         `T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}Z`
}

class FileExporter extends EventSerializer {
  constructor (config = {}) {
    super(config)
    const { pprofPrefix } = config
    this._pprofPrefix = pprofPrefix || ''
  }

  export (exportSpec) {
    const { profiles, end } = exportSpec
    const types = Object.keys(profiles)
    const dateStr = formatDateTime(end)
    const tasks = types.map(type => {
      return writeFile(`${this._pprofPrefix}${type}_worker_${threadId}_${dateStr}.pprof`, profiles[type])
    })
    tasks.push(writeFile(`event_worker_${threadId}_${dateStr}.json`, this.getEventJSON(exportSpec)))
    return Promise.all(tasks)
  }
}

module.exports = { FileExporter }
