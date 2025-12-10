'use strict'

const path = require('path')
const { existsSync, readFileSync } = require('fs')
const { getEnvironmentVariable } = require('../../../dd-trace/src/config-helper')
/**
 * This function aims to extract the output of the prisma client.
 * It tries to extract the output from locations where the schema.prisma is
 * usally located at.
 */
let extractedOutput
module.exports = function extractOutput () {
  const prismaEnv = (getEnvironmentVariable('DD_PRISMA_OUTPUT') || '').trim()

  if (prismaEnv && prismaEnv !== 'auto') return prismaEnv

  if (!prismaEnv) return null

  const root = process.cwd()
  const dir = path.join(root, 'prisma')

  // No need of redoing all this process if it has already been done
  if (extractedOutput) return extractedOutput

  if (existsSync(path.join(dir, 'schema.prisma'))) {
    const schema = readFileSync(`${dir}/${'schema.prisma'}`, 'utf8')
    const match = schema.match(/output\s*=\s*["']([^"']+)["']/)

    if (!match) {
      return null
    }

    const relativePath = path.relative(root, path.resolve(dir, match[1]))
    extractedOutput = relativePath
    return extractedOutput
  }

  // try to find it in the package.json which is another location prisma cli uses for schema resolution
  if (existsSync(path.join(root, 'package.json'))) {
    const packageJsonFile = readFileSync(path.join(root, 'package.json'), 'utf8')
    const parsedPackageJson = JSON.parse(packageJsonFile)

    // In this case returning should suffice since it's defined from the root
    if (parsedPackageJson.prisma?.schema) {
      extractedOutput = parsedPackageJson.prisma.schema
      return extractedOutput
    }
  }
}
