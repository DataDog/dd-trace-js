#pragma once

#include <string>
#include <node_version.h>
#include <v8.h>

namespace datadog {
  std::string to_string(v8::Isolate *isolate, v8::Local<v8::Value> handle);
}
