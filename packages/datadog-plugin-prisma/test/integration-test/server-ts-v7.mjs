import 'dd-trace/init.js'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './dist/client.js'

const adapterConfig = process.env.PRISMA_PG_ADAPTER_CONFIG === 'fields'
  ? {
      host: 'localhost',
      port: 5432,
      user: 'postgres',
      password: 'postgres',
      database: 'postgres',
    }
  : { connectionString: process.env.DATABASE_URL }
const adapter = new PrismaPg(adapterConfig)
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
