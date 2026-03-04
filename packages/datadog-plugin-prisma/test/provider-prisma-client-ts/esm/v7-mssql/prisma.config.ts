import { defineConfig } from "prisma/config"

export default defineConfig({
  datasource: {
    url: process.env.TEST_MSSQL_DATABASE_URL
  },
})
