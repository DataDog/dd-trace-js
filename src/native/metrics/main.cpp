#include <nan.h>

#include "EventLoop.hpp"
#include "HistogramAdapter.hpp"

using namespace v8;

namespace datadog {
  EventLoop* eventLoop = new EventLoop();
  HistogramAdapter* histogramAdapter = new HistogramAdapter(eventLoop);

  static NAN_METHOD(start) {
    eventLoop->enable();
  }

  static NAN_METHOD(stop) {
    eventLoop->disable();
  }

  static NAN_METHOD(stats) {
    Local<Object> obj = Nan::New<Object>();

    Nan::Set(
      obj,
      Nan::New("eventLoop").ToLocalChecked(),
      histogramAdapter->to_object()
    );

    info.GetReturnValue().Set(obj);

    eventLoop->reset();
  }

  NAN_MODULE_INIT(init) {
    Nan::Set(
      target,
      Nan::New("start").ToLocalChecked(),
      Nan::GetFunction(Nan::New<FunctionTemplate>(start)).ToLocalChecked()
    );

    Nan::Set(
      target,
      Nan::New("stop").ToLocalChecked(),
      Nan::GetFunction(Nan::New<FunctionTemplate>(stop)).ToLocalChecked()
    );

    Nan::Set(
      target,
      Nan::New("stats").ToLocalChecked(),
      Nan::GetFunction(Nan::New<FunctionTemplate>(stats)).ToLocalChecked()
    );
  }

  NODE_MODULE(dd_trace_native, init);
}
