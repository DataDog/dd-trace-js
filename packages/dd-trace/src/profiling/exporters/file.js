'use strict'

const fs = require('fs')
const { promisify } = require('util')
const writeFile = promisify(fs.writeFile)

class FileExporter {
  constructor () {
    this._encoder = new Encoder()
  }

  export ({ profiles }) {
    const types = Object.keys(profiles)
    const tasks = types.map(async (type) => {
      const buffer = await this._encoder.encode(profiles[type])
      return writeFile(`${type}.pb.gz`, buffer)
    })

    return Promise.all(tasks)
  }
}

module.exports = { FileExporter }
