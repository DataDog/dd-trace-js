#!/usr/bin/env bash

# Previously, URLs to plugin pages looked like this:
# interfaces/export_.plugins.connect.html
#
# Now, with an updated typedoc and updated types, they look like this:
# interfaces/plugins.amqp10.html
#
# This script automatically generates basic HTML files to redirect users who
# visit the old URLs to the new URL.

echo "writing redirects..."
# TODO(2026-10-07): Delete this file and remove from docs/package.json
# NOTE: Do not add any new entries to this list

declare -a plugins=(
  "aerospike"
  "amqp10"
  "amqplib"
  "apollo"
  "avsc"
  "aws_sdk"
  "axios"
  "azure_functions"
  "azure_service_bus"
  "bunyan"
  "cassandra_driver"
  "child_process"
  "confluentinc_kafka_javascript"
  "connect"
  "couchbase"
  "cucumber"
  "cypress"
  "dns"
  "elasticsearch"
  "express"
  "fastify"
  "fetch"
  "generic_pool"
  "google_cloud_pubsub"
  "google_cloud_vertexai"
  "graphql"
  "grpc"
  "hapi"
  "hono"
  "http"
  "http2"
  "ioredis"
  "iovalkey"
  "jest"
  "kafkajs"
  "knex"
  "koa"
  "langchain"
  "ldapjs"
  "mariadb"
  "memcached"
  "microgateway_core"
  "mocha"
  "mongodb_core"
  "mongoose"
  "mysql"
  "mysql2"
  "net"
  "next"
  "openai"
  "opensearch"
  "oracledb"
  "pg"
  "pino"
  "playwright"
  "polka"
  "prisma"
  "protobufjs"
  "redis"
  "restify"
  "rhea"
  "router"
  "selenium"
  "sharedb"
  "tedious"
  "undici"
  "vitest"
  "winston"
)

for i in "${plugins[@]}"
do
  echo "<meta http-equiv=\"refresh\" content=\"0; URL=./plugins.$i.html\" />" > out/interfaces/export_.plugins.$i.html
done

echo "done."
