import 'dd-trace/init.js'
import { PrismaClient } from '@prisma/client'

const prismaClient = new PrismaClient()
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
