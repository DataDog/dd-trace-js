#pragma once

#include <nan.h>

#include "Histogram.hpp"

namespace datadog {
  class HistogramAdapter {
    public:
      HistogramAdapter(Histogram* histogram);

      v8::Local<v8::Object> to_object();
    private:
      Histogram* histogram_;
  };
}
