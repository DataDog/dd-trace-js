#!/usr/bin/env bash

# Previously, URLs to plugin pages looked like this:
# interfaces/plugins.amqp10.html
#
# Now, with an updated typedoc and updated types, they look like this:
# interfaces/export_.plugins.connect.html
# 
# This script automatically generates basic HTML files to redirect users who
# visit the old URLs to the new URL.

echo "writing redirects..."

declare -a plugins=(
  "amqp10"
  "amqplib"
  "avsc"
  "aws_sdk"
  "bluebird"
  "couchbase"
  "cucumber"
  "bunyan"
  "cassandra_driver"
  "confluentinc_kafka_javascript"
  "connect"
  "dns"
  "elasticsearch"
  "express"
  "fastify"
  "fetch"
  "generic_pool"
  "google_cloud_pubsub"
  "graphql"
  "grpc"
  "hapi"
  "http"
  "http2"
  "ioredis"
  "iovalkey"
  "jest"
  "kafkajs"
  "knex"
  "koa"
  "ldapjs"
  "mariadb"
  "microgateway_core"
  "mocha"
  "mongodb_core"
  "mysql"
  "mysql2"
  "net"
  "next"
  "opensearch"
  "openai"
  "oracledb"
  "pino"
  "pg"
  "prisma"
  "promise"
  "promise_js"
  "protobufjs"
  "q"
  "redis"
  "restify"
  "router"
  "tedious"
  "undici"
  "when"
  "winston"
  "ws"
)

for i in "${plugins[@]}"
do
   echo "<meta http-equiv=\"refresh\" content=\"0; URL=./export_.plugins.$i.html\" />" > out/interfaces/plugins.$i.html
done

echo "done."
