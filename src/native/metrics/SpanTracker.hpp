#pragma once

#include <map>
#include <string>
#include <v8.h>

#include "Collector.hpp"
#include "Histogram.hpp"
#include "Object.hpp"

namespace datadog {
  class SpanTracker;

  struct SpanHandle {
    SpanTracker *tracker;
    v8::Persistent<v8::Object> *span;
    std::string name;
  };

  class SpanTracker : Collector {
    public:
      void inject(Object carrier);
      void track(const v8::Local<v8::Object> &span);
      void enable(bool debug);
      void disable();
    private:
      static void callback(const v8::WeakCallbackInfo<SpanHandle> &data);

      bool debug_;
      bool enabled_;
      std::map<std::string, uint64_t> spans_;
      uint64_t total_;
  };
}
