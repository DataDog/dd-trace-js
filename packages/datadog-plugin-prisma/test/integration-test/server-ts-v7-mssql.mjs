import 'dd-trace/init.js'
// @ts-expect-error adapter is installed in the integration sandbox
import { PrismaMssql } from '@prisma/adapter-mssql'
// @ts-expect-error generated in the integration sandbox
import { PrismaClient } from './dist/client.js'

const adapterConfig = process.env.PRISMA_MSSQL_ADAPTER_CONFIG === 'fields'
  ? {
      server: 'localhost',
      port: 1433,
      user: 'sa',
      password: 'DD_HUNTER2',
      database: 'master',
      options: {
        encrypt: true,
        trustServerCertificate: true,
      },
    }
  : process.env.DATABASE_URL
const adapter = new PrismaMssql(adapterConfig)
const prismaClient = new PrismaClient({ adapter })
const user = await prismaClient.user.create({
  data: {
    name: 'John Doe',
    email: 'john.doe@datadoghq.com',
  },
})

await prismaClient.user.findUnique({
  where: {
    id: user.id,
  },
})
