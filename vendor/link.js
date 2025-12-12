'use strict'

const { readdirSync, statSync, writeFileSync, existsSync } = require("fs")
const { join } = require("path")

addPackageJson(join(__dirname, 'dist'))

// TODO: Can we do this with Rspack instead?
function addPackageJson (root) {
  const folders = readdirSync(root)

  for (const name of folders) {
    const folder = join(root, name)
    const stat = statSync(folder)
    const filename = join(folder, 'package.json')

    if (!stat.isDirectory()) continue

    addPackageJson(join(root, name))

    if (!existsSync(join(folder, 'index.js'))) continue

    const pkg = { name, version: '0.0.0' }

    writeFileSync(filename, JSON.stringify(pkg, null, 2) + '\n')
  }
}
