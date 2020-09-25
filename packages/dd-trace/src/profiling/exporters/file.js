'use strict'

const { writeFile } = require('fs')
const { Encoder } = require('../encoders/pprof')
const { parallel } = require('../util')

class FileExporter {
  constructor () {
    this._encoder = new Encoder()
  }

  export ({ profiles }, callback) {
    const types = Object.keys(profiles)
    const tasks = types.map(type => cb => this._write(type, profiles[type], cb))

    parallel(tasks, callback)
  }

  _write (type, profile, callback) {
    this._encoder.encode(profile, (err, buffer) => {
      if (err) return callback(err)

      writeFile(`${type}.pb.gz`, buffer, callback)
    })
  }
}

module.exports = { FileExporter }
