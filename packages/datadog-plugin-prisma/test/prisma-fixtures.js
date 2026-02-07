'use strict'

// Shared test constants for prisma plugin tests.

const TEST_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/postgres'
const TEST_DATABASE_ENV_NAME = 'PRISMA_TEST_DATABASE_URL'
const FALLBACK_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/fallback'
const TEST_MARIADB_DATABASE_URL = 'mysql://root@localhost:3306/db'
const TEST_MSSQL_DATABASE_URL = [
  'sqlserver://localhost:1433;database=master;user=sa;password=DD_HUNTER2;',
  'encrypt=true;trustServerCertificate=true',
].join('')
const TEST_MONGODB_DATABASE_URL = 'mongodb://localhost:27017/prisma?replicaSet=rs0'

const PRISMA_CLIENT_OUTPUT_RELATIVE = '../generated/prisma'

const SCHEMA_FIXTURES = {
  clientJs: 'provider-prisma-client-js/schema.prisma',
  clientOutputJs: 'provider-prisma-client-js/output/schema.prisma',
  tsCjsV6: 'provider-prisma-client-ts/cjs/v6/schema.prisma',
  tsCjsV7: 'provider-prisma-client-ts/cjs/v7/schema.prisma',
  tsEsmV6: 'provider-prisma-client-ts/esm/v6/schema.prisma',
  tsEsmV7: 'provider-prisma-client-ts/esm/v7/schema.prisma',
  tsEsmV7Config: 'provider-prisma-client-ts/esm/v7/prisma.config.ts',
  tsEsmV6Mongo: 'provider-prisma-client-ts/esm/v6-mongo/schema.prisma',
  tsEsmV7Mariadb: 'provider-prisma-client-ts/esm/v7-mariadb/schema.prisma',
  tsEsmV7MariadbConfig: 'provider-prisma-client-ts/esm/v7-mariadb/prisma.config.ts',
  tsEsmV7Mssql: 'provider-prisma-client-ts/esm/v7-mssql/schema.prisma',
  tsEsmV7MssqlConfig: 'provider-prisma-client-ts/esm/v7-mssql/prisma.config.ts',
}

module.exports = {
  FALLBACK_DATABASE_URL,
  PRISMA_CLIENT_OUTPUT_RELATIVE,
  SCHEMA_FIXTURES,
  TEST_DATABASE_ENV_NAME,
  TEST_DATABASE_URL,
  TEST_MARIADB_DATABASE_URL,
  TEST_MSSQL_DATABASE_URL,
  TEST_MONGODB_DATABASE_URL,
}
