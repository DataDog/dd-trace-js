import { defineConfig } from "prisma/config"

export default defineConfig({
  datasource: {
    url: "postgres://postgres:postgres@localhost:5432/postgres"
  }
})
