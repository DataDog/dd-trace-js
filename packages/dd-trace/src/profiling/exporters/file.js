'use strict'

const fs = require('fs')
const util = require('util')
const { Encoder } = require('../encoders/pprof')

const writeFile = util.promisify(fs.writeFile)

class FileExporter {
  constructor () {
    this._encoder = new Encoder()
  }

  async export ({ profiles }) {
    const types = Object.keys(profiles)
    const promises = types.map(type => this._write(type, profiles[type]))

    return Promise.all(promises)
  }

  async _write (type, profile) {
    const buffer = await this._encoder.encode(profile)

    return writeFile(`${type}.pb.gz`, buffer)
  }
}

module.exports = { FileExporter }
