import 'dd-trace/init.js'
// @ts-expect-error adapter is installed in the integration sandbox
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
// @ts-expect-error generated in the integration sandbox
import { PrismaClient } from './dist/client.js'

const adapter = new PrismaMariaDb(process.env.DATABASE_URL)
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

await prismaClient.$disconnect()
