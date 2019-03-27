#pragma once

#include <string>
#include <nan.h>
#include <v8.h>

namespace datadog {
  std::string to_string(v8::Local<v8::Value> handle);
}
