#pragma once

#include <string>
#include <v8.h>

namespace datadog {
  std::string to_string(v8::Local<v8::Value> handle);
  v8::Local<v8::String> from_string(std::string str);
  v8::Local<v8::String> from_string(std::string str);
  template <class T> v8::Local<T> value(v8::Local<v8::Object> obj, std::string key);
}
