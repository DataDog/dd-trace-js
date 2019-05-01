#pragma once

#include <unordered_map>
#include <string>
#include <v8.h>

#include "Collector.hpp"
#include "Object.hpp"

namespace datadog {
  class SpanTracker;

  struct SpanHandle {
    SpanTracker *tracker;
    v8::Persistent<v8::Object> *context;
    bool finished;
    std::string name;
  };

  class SpanTracker : Collector {
    public:
      void inject(Object carrier);
      SpanHandle* track(const v8::Local<v8::Object> &span);
      void finish(SpanHandle *handle);
      void enable();
      void disable();
    private:
      static void callback(const v8::WeakCallbackInfo<SpanHandle> &data);

      bool enabled_;
      std::unordered_map<std::string, uint64_t> unfinished_;
      std::unordered_map<std::string, uint64_t> finished_;
      uint64_t unfinished_total_;
      uint64_t finished_total_;
  };
}
