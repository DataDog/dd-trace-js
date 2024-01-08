'use strict'

const fs = require('fs')
const { promisify } = require('util')
const { threadId } = require('worker_threads')
const writeFile = promisify(fs.writeFile)

function formatDateTime (t) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}` +
         `T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}Z`
}

class FileExporter {
  constructor ({ pprofPrefix } = {}) {
    this._pprofPrefix = pprofPrefix || ''
  }

  export ({ profiles, end }) {
    const types = Object.keys(profiles)
    const dateStr = formatDateTime(end)
    const tasks = types.map(type => {
      return writeFile(`${this._pprofPrefix}${type}_worker_${threadId}_${dateStr}.pprof`, profiles[type])
    })

    return Promise.all(tasks)
  }
}

module.exports = { FileExporter }
