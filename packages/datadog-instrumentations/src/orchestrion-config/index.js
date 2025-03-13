const path = require('path')
const fs = require('fs')

// TODO this needs to be inlined to prevent issues in bundling
module.exports = fs.readFileSync(path.join(__dirname, '../../orchestrion.yml'), 'utf8')
