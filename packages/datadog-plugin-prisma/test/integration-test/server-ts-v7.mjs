import 'dd-trace/init.js'
import { PrismaPg } from '@prisma/adapter-pg'
import prismaLib from './dist/client.js'

const adapter = new PrismaPg({ connectionString: `${process.env.DATABASE_URL}` })
const prismaClient = new prismaLib.PrismaClient({ adapter })
const user = await prismaClient.user.create({
  data: {
    name: 'John Doe',
    email: 'john.doe@datadoghq.com'
  }
})

await prismaClient.user.findUnique({
  where: {
    id: user.id
  }
})
