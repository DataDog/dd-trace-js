#pragma once

#include <string>
#include <v8.h>

namespace datadog {
  std::string to_string(v8::Local<v8::Value> handle);
}
