import 'dd-trace/init.js'
import path from 'path'
import { execSync } from 'child_process'
import prisma from '@prisma/client'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// execute the prisma generate using the schema.prisma in the parent directory
const cwd = path.resolve(__dirname, '../')
const schemaPath = path.resolve(__dirname, 'schema.prisma')

execSync(`./node_modules/.bin/prisma generate --schema=${schemaPath}`, {
  cwd, // Ensure the current working directory is where the schema is located
  stdio: 'inherit'
})

const prismaClient = new prisma.PrismaClient()
await prismaClient.user.create({
  data: {
    name: 'John Doe'
  }
})
