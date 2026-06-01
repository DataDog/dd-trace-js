import { defineConfig } from "prisma/config"

export default defineConfig({
  datasource: {
    url: "mysql://root@localhost:3306/db"
  }
})
