import 'dd-trace/init.js'
import prismaLib from './generated/prisma/index.js'

const prismaClient = new prismaLib.PrismaClient()
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
