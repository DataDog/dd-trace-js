'use strict'

const fs = require('fs')
const { promisify } = require('util')
const writeFile = promisify(fs.writeFile)

class FileExporter {
  export ({ profiles }) {
    const types = Object.keys(profiles)
    const tasks = types.map(type => {
      return writeFile(`${type}.pb.gz`, profiles[type])
    })

    return Promise.all(tasks)
  }
}

module.exports = { FileExporter }
