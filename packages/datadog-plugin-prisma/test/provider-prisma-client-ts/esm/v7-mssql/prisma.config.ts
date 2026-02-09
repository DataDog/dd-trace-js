import { defineConfig } from "prisma/config"

export default defineConfig({
  datasource: {
    url: 'sqlserver://localhost:1433;database=master;user=sa;password=DD_HUNTER2;' +
      'encrypt=true;trustServerCertificate=true',
  },
})
