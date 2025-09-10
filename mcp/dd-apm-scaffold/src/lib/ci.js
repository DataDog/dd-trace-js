'use strict'

const fs = require('fs-extra')

async function addSimpleCIJob (workflowPath, integrationId, opts = {}) {
  if (!await fs.pathExists(workflowPath)) return
  const yml = await fs.readFile(workflowPath, 'utf8')
  const jobName = integrationId.replace(/\./g, '-')

  // Known service mappings (non-exhaustive); only used when exact service is known
  const knownServices = {
    // messaging
    bullmq: { service: 'redis', image: 'redis:6.2-alpine', ports: ['6379:6379'] },
    amqplib: { service: 'rabbitmq', image: 'rabbitmq:3.6-alpine', ports: ['5672:5672'] },
    amqp10: { service: 'qpid', image: 'scholzj/qpid-cpp:1.38.0', ports: ['5673:5672'] },
    rhea: { service: 'qpid', image: 'scholzj/qpid-cpp:1.38.0', ports: ['5673:5672'] },
    'confluentinc-kafka-javascript': { service: 'kafka', image: 'apache/kafka-native:3.8.0-rc2', ports: ['9092:9092', '9093:9093'] },
    // databases
    mysql: { service: 'mysql', image: 'mariadb:10.4', ports: ['3306:3306'], env: { MYSQL_ALLOW_EMPTY_PASSWORD: 'yes', MYSQL_DATABASE: 'db' } },
    mysql2: { service: 'mysql', image: 'mariadb:10.4', ports: ['3306:3306'], env: { MYSQL_ALLOW_EMPTY_PASSWORD: 'yes', MYSQL_DATABASE: 'db' } },
    pg: { service: 'postgres', image: 'postgres:9.5', ports: ['5432:5432'], env: { POSTGRES_PASSWORD: 'postgres' } },
    'cassandra-driver': { service: 'cassandra', image: 'cassandra:3-focal', ports: ['9042:9042'] },
    mongoose: { service: 'mongodb', image: 'circleci/mongo', ports: ['27017:27017'] },
    'mongodb-core': { service: 'mongodb', image: 'circleci/mongo', ports: ['27017:27017'] },
    mongodb: { service: 'mongodb', image: 'circleci/mongo', ports: ['27017:27017'] },
    // caches
    redis: { service: 'redis', image: 'redis:6.2-alpine', ports: ['6379:6379'] },
    ioredis: { service: 'redis', image: 'redis:6.2-alpine', ports: ['6379:6379'] },
    iovalkey: { service: 'valkey', image: 'valkey/valkey:8.1-alpine', ports: ['6379:6379'] }
  }

  // Optional explicit service config from caller overrides known mapping
  const explicit = opts.serviceConfig || null
  const known = knownServices[integrationId] || null
  const resolved = explicit || known || null

  const lines = yml.split('\n')
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ')

  const jobsIdx = lines.findIndex(l => /^jobs:\s*$/.test(l))
  if (jobsIdx === -1) return

  // If job exists, sanitize or update
  const jobStartIdx = lines.findIndex(l => l === `  ${jobName}:`)
  if (jobStartIdx !== -1) {
    // Remove hallucinated generic services (alpine) and SERVICES env if we don't have a resolved mapping
    const jobEndIdx = (() => {
      for (let i = jobStartIdx + 1; i < lines.length; i++) {
        const m = lines[i].match(/^ {2}([^\s][^:]*):\s*$/)
        if (m) return i
      }
      return lines.length
    })()

    if (!resolved) {
      // remove SERVICES env line in this block
      for (let i = jobStartIdx + 1; i < jobEndIdx; i++) {
        if (/^\s{6}SERVICES: /.test(lines[i])) { lines.splice(i, 1); jobEndIdx--; break }
      }
      // remove generic services block with alpine image
      let servicesBlockStart = -1
      for (let i = jobStartIdx + 1; i < jobEndIdx; i++) {
        if (lines[i] === '    services:') { servicesBlockStart = i; break }
      }
      if (servicesBlockStart !== -1) {
        // find end at next '    steps:' or next job
        let servicesBlockEnd = jobEndIdx
        for (let i = servicesBlockStart + 1; i < jobEndIdx; i++) {
          if (lines[i] === '    steps:' || /^ {2}[^\s].*:/.test(lines[i])) { servicesBlockEnd = i; break }
        }
        const blockContainsAlpine = lines.slice(servicesBlockStart, servicesBlockEnd).some(l => /image:\s+alpine:3/.test(l))
        if (blockContainsAlpine) {
          lines.splice(servicesBlockStart, servicesBlockEnd - servicesBlockStart)
        }
      }
      await fs.writeFile(workflowPath, lines.join('\n'))
      return
    }

    // If we have a resolved mapping, ensure services block/env are present (idempotent)
    // Add SERVICES env if missing
    let envIdx = -1
    for (let i = jobStartIdx + 1; i < jobEndIdx; i++) {
      if (lines[i] === '    env:') { envIdx = i; break }
    }
    if (envIdx !== -1) {
      const haveServicesEnv = lines.slice(envIdx + 1, jobEndIdx).some(l => /^\s{6}SERVICES: /.test(l))
      if (!haveServicesEnv) {
        const pluginsLineIdx = lines.slice(envIdx + 1, jobEndIdx).findIndex(l => /^\s{6}PLUGINS: /.test(l))
        const insertAt = pluginsLineIdx !== -1 ? envIdx + 2 : envIdx + 1
        lines.splice(insertAt, 0, `      SERVICES: ${resolved.service}`)
      }
    }
    // Add or replace services block
    let servicesIdx = -1
    for (let i = jobStartIdx + 1; i < jobEndIdx; i++) {
      if (lines[i] === '    services:') { servicesIdx = i; break }
    }
    if (servicesIdx === -1) {
      const stepsIdx = lines.slice(jobStartIdx + 1, jobEndIdx).findIndex(l => l === '    steps:')
      const at = stepsIdx !== -1 ? jobStartIdx + 1 + stepsIdx : jobEndIdx
      const block = ['    services:', `      ${resolved.service}:`, `        image: ${resolved.image}`]
      if (resolved.env) for (const [k, v] of Object.entries(resolved.env)) block.push('        env:', `          ${k}: ${v}`)
      if (resolved.ports && resolved.ports.length) {
        block.push('        ports:')
        for (const p of resolved.ports) block.push(`          - ${p}`)
      }
      lines.splice(at, 0, ...block)
    }
    await fs.writeFile(workflowPath, lines.join('\n'))
    return
  }

  // Create new job
  const newBlock = [`  ${jobName}:`,
    '    runs-on: ubuntu-latest',
    '    env:',
    `      PLUGINS: ${integrationId}` + (resolved ? `\n      SERVICES: ${resolved.service}` : ''),
    ...(resolved
      ? (function () {
          const block = ['    services:', `      ${resolved.service}:`, `        image: ${resolved.image}`]
          if (resolved.env) { block.push('        env:'); for (const [k, v] of Object.entries(resolved.env)) block.push(`          ${k}: ${v}`) }
          if (resolved.ports && resolved.ports.length) { block.push('        ports:'); for (const p of resolved.ports) block.push(`          - ${p}`) }
          return block
        })()
      : []),
    '    steps:',
    '      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2',
    '      - uses: ./.github/actions/plugins/test',
    '']
  let insertAt = lines.length
  for (let i = jobsIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^ {2}([^\s][^:]*):\s*$/)
    if (!m) continue
    const existing = m[1]
    if (norm(existing) > norm(jobName)) { insertAt = i; break }
  }
  lines.splice(insertAt, 0, ...newBlock)
  await fs.writeFile(workflowPath, lines.join('\n'))
}

module.exports = { addSimpleCIJob }
