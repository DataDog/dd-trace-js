#include "HistogramAdapter.hpp"
#include "Object.hpp"

using namespace v8;

namespace datadog {
  HistogramAdapter::HistogramAdapter(Histogram* histogram) {
    histogram_ = histogram;
  }

  v8::Local<v8::Object> HistogramAdapter::to_object() {
    Object obj;

    obj.set("min", histogram_->min());
    obj.set("max", histogram_->max());
    obj.set("sum", histogram_->sum());
    obj.set("avg", histogram_->avg());
    obj.set("count", histogram_->count());

    return obj.to_json();
  }
}
