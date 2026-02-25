import 'dd-trace/init.js'
import { PrismaClient } from './dist/client.js'

const prismaClient = new PrismaClient()
const unique = `${Date.now()}-${process.pid}`
const user = await prismaClient.user.create({
  data: {
    name: 'John Doe',
    email: `john.doe+${unique}@datadoghq.com`,
  },
})

await prismaClient.user.findUnique({
  where: {
    id: user.id,
  },
})
