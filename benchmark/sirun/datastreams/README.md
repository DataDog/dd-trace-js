This benchmark measures the per-message DSM pathway hot path that fires on every
traced Kafka, SQS, SNS, Kinesis, Pub/Sub, and AMQP message when Data Streams
Monitoring is enabled. Each iteration covers `setCheckpoint` (sort edge tags,
build the LRU cache key, sha-hash on miss, accumulate the sketches in the
bucket), the pathway codec, and the size accounting.
