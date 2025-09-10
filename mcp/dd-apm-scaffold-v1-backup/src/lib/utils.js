'use strict'

function deriveIdsFromNpmName (npmName) {
  const integrationId = npmName.replace(/^@/, '').replace(/[\/]/g, '-').replace(/\.+/g, '-').replace(/-+/g, '-')
  const typesId = npmName.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return { integrationId, typesId }
}

function normalizeForChannel (name) {
  return String(name).replace(/^@/, '').replace(/[\/.]/g, '-').replace(/-+/g, '-')
}

function normalizeForSort (name) {
  return String(name).toLowerCase().replace(/^["']|["']$/g, '').replace(/[^a-z0-9]+/g, ' ')
}

module.exports = {
  deriveIdsFromNpmName,
  normalizeForChannel,
  normalizeForSort,
  detectCategory,
  toPascalCase,
  getOperationForCategory
}

function detectCategory (npmName) {
  const name = String(npmName).toLowerCase()
  if (/mysql|pg|mariadb|oracledb|mongoose|mongodb|redis|ioredis|valkey|cassandra|tedious|sequelize/.test(name)) {
    return 'db'
  }
  if (/express|fastify|hapi|koa|hono|restify|next|connect|router|apollo/.test(name)) {
    return 'web'
  }
  if (/undici|fetch|http2?|axios/.test(name)) {
    return 'http'
  }
  if (/kafka|amqplib|amqp10|rhea|pubsub|sns|sqs|rabbit|confluent|bull|bullmq|queue/.test(name)) {
    return 'messaging'
  }
  if (/memcached|generic-pool|cache/.test(name)) {
    return 'cache'
  }
  return 'other'
}

function toPascalCase (integrationId) {
  return String(integrationId)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join('')
}

function getOperationForCategory (category, fallback) {
  switch (category) {
    case 'db': return 'query'
    case 'web': return 'request'
    case 'http': return 'request'
    case 'messaging': return 'produce'
    case 'cache': return 'command'
    default: return fallback || 'request'
  }
}
