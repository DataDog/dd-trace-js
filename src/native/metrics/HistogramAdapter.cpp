#include "HistogramAdapter.hpp"

using namespace v8;

namespace datadog {
  HistogramAdapter::HistogramAdapter(Histogram* histogram) {
    histogram_ = histogram;
  }

  Local<Object> HistogramAdapter::to_object() {
    Local<Object> obj = Nan::New<Object>();

    Nan::Set(
      obj,
      Nan::New("min").ToLocalChecked(),
      Nan::New<Number>(histogram_->min())
    );

    Nan::Set(
      obj,
      Nan::New("max").ToLocalChecked(),
      Nan::New<Number>(histogram_->max())
    );

    Nan::Set(
      obj,
      Nan::New("sum").ToLocalChecked(),
      Nan::New<Number>(histogram_->sum())
    );

    Nan::Set(
      obj,
      Nan::New("avg").ToLocalChecked(),
      Nan::New<Number>(histogram_->avg())
    );

    Nan::Set(
      obj,
      Nan::New("count").ToLocalChecked(),
      Nan::New<Number>(histogram_->count())
    );

    return obj;
  }
}
