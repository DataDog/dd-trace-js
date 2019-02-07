# Microservices example

This example has all features enabled for Node APM on 3 services.

The following modules are automatically instrumented by our integrations:

- dns
- express
- graphql
- http
- mongodb-core
- net
- redis
- winston

## Running

```sh
DD_API_KEY=<a_valid_api_key> docker-compose up -d --build
```

## Generating Traces

Visit `http://localhost:8080/users` to generate traces.
