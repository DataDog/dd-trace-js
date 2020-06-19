// windows.h defines min and max macros.
#define NOMINMAX
#include <algorithm>
#undef min
#undef max
#undef NOMINMAX

#include <stdint.h>
#include <map>
#include <unordered_map>
#include <memory>
#include <sstream>

#include <tdigest/TDigest.h>

#define NAPI_VERSION 1 // https://nodejs.org/api/n-api.html#n_api_n_api_version_matrix
#include <napi.h>
#include <uv.h>
#include <v8.h>

using Napi::Array;
using Napi::CallbackInfo;
using Napi::Env;
using Napi::Error;
using Napi::Float64Array;
using Napi::Function;
using Napi::Number;
using Napi::Object;
using Napi::String;
using Napi::Value;

class Histogram {
 public:
  static constexpr size_t BufferSize = 7;

  Histogram() { Reset(); }

  void Add(uint64_t value) {
    if (count_ == 0) {
      min_ = max_ = value;
    } else {
      min_ = (std::min)(min_, value);
      max_ = (std::max)(max_, value);
    }

    count_ += 1;
    sum_ += value;

    digest_->add(static_cast<tdigest::Value>(value));
  }

  uint64_t Percentile(double value) {
    return count_ == 0 ? 0 :
        static_cast<uint64_t>(std::round(digest_->quantile(value)));
  }

  void Reset() {
    min_ = 0;
    max_ = 0;
    sum_ = 0;
    count_ = 0;
    digest_ = std::make_shared<tdigest::TDigest>(1000);
  }

  void ToValue(Float64Array& a, size_t offset = 0) {
    a[offset + 0] = min_;
    a[offset + 1] = max_;
    a[offset + 2] = sum_;
    a[offset + 3] = count_ == 0 ? 0 : sum_ / count_;
    a[offset + 4] = count_;
    a[offset + 5] = Percentile(0.50);
    a[offset + 6] = Percentile(0.95);
  }

 private:
  uint64_t min_;
  uint64_t max_;
  uint64_t sum_;
  uint64_t count_;
  std::shared_ptr<tdigest::TDigest> digest_;
};


  ///////////////////
 // GC STATISTICS //
///////////////////
class GCStat {
 public:
  ~GCStat() { Stop(); }

  void Start() {
    v8::Isolate* isolate = v8::Isolate::GetCurrent();
    isolate->AddGCPrologueCallback(OnPrologue, this);
    isolate->AddGCEpilogueCallback(OnEpilogue, this);
  }

  void Stop() {
    v8::Isolate* isolate = v8::Isolate::GetCurrent();
    if (isolate) {
      isolate->RemoveGCPrologueCallback(OnPrologue, this);
      isolate->RemoveGCEpilogueCallback(OnEpilogue, this);
    }
  }

  void Dump(Env env, Object& o) {
    auto a = Float64Array::New(env, (1 + Histogram::BufferSize) * pause_.size());

    size_t i = 0;
    for (auto& it : pause_) {
      a[i++] = it.first;
      it.second.ToValue(a, i);
      i += Histogram::BufferSize;
    }

    o["gc"] = a;
  }

 private:
  static void OnPrologue(v8::Isolate*, v8::GCType, v8::GCCallbackFlags, void* data) {
    auto self = reinterpret_cast<GCStat*>(data);
    self->start_time_ = uv_hrtime();
  }

  static void OnEpilogue(v8::Isolate*, v8::GCType type, v8::GCCallbackFlags, void* data) {
    auto self = reinterpret_cast<GCStat*>(data);
    uint64_t usage = uv_hrtime() - self->start_time_;

    if (self->pause_.find(type) == self->pause_.end()) {
      self->pause_[type] = Histogram();
    }

    self->pause_[type].Add(usage);
    self->pause_[v8::GCType::kGCTypeAll].Add(usage);
  }

  std::map<v8::GCType, Histogram> pause_;
  uint64_t start_time_;
};


  ///////////////////////////
 // EVENT LOOP STATISTICS //
///////////////////////////
class EventLoopStat {
 public:
  static constexpr size_t BufferSize = Histogram::BufferSize;

  EventLoopStat() {
    uv_prepare_init(uv_default_loop(), &prepare_handle_);
    uv_unref(reinterpret_cast<uv_handle_t*>(&prepare_handle_));
    prepare_handle_.data = reinterpret_cast<void*>(this);

    uv_check_init(uv_default_loop(), &check_handle_);
    uv_unref(reinterpret_cast<uv_handle_t*>(&check_handle_));
    check_handle_.data = reinterpret_cast<void*>(this);

    check_time_ = uv_hrtime();
  }

  ~EventLoopStat() { Stop(); }

  void Start() {
    uv_prepare_start(&prepare_handle_, OnPrepare);
    uv_check_start(&check_handle_, OnCheck);
  }

  void Stop() {
    uv_prepare_stop(&prepare_handle_);
    uv_check_stop(&check_handle_);
    histogram_.Reset();
  }

  void Dump(Float64Array& a) {
    histogram_.ToValue(a);
    histogram_.Reset();
  }

 private:
  static void OnPrepare(uv_prepare_t* handle) {
    auto self = reinterpret_cast<EventLoopStat*>(handle->data);
    self->prepare_time_ = uv_hrtime();
    self->timeout_ = uv_backend_timeout(uv_default_loop());
  }

  static void OnCheck(uv_check_t* handle) {
    auto self = reinterpret_cast<EventLoopStat*>(handle->data);

    uint64_t check_time = uv_hrtime();
    uint64_t poll_time = check_time - self->prepare_time_;
    uint64_t latency = self->prepare_time_ - self->check_time_;
    uint64_t timeout = self->timeout_ * 1000 * 1000;

    if (poll_time > timeout) {
      latency += poll_time - timeout;
    }

    self->histogram_.Add(latency);
    self->check_time_ = check_time;
  }

  uv_check_t check_handle_;
  uv_prepare_t prepare_handle_;
  uint64_t check_time_;
  uint64_t prepare_time_;
  uint64_t timeout_;
  Histogram histogram_;
};

  ///////////////////
 // PROCESS STATS //
///////////////////

static uint64_t time_to_micro(uv_timeval_t timeval) {
  return timeval.tv_sec * 1000 * 1000 + timeval.tv_usec;
}

class ProcessStat {
 public:
  static constexpr size_t BufferSize = 2;

  void Dump(Float64Array& a) {
    uv_rusage_t usage;
    uv_getrusage(&usage);

    a[0] = time_to_micro(usage.ru_utime) - time_to_micro(usage_.ru_utime);
    a[1] = time_to_micro(usage.ru_stime) - time_to_micro(usage_.ru_stime);

    usage_ = usage;
  }

 private:
  uv_rusage_t usage_;
};

  ///////////////////////
 // STRING INTERNING //
///////////////////////
static std::unordered_map<std::string, uint64_t> interned_strings;
static uint64_t InternString(std::string s, Array& a) {
  auto it = interned_strings.find(s);
  if (it != interned_strings.end()) {
    return it->second;
  }
  uint64_t id = interned_strings.size();
  interned_strings[s] = id;
  a[id] = s;
  return id;
}


  /////////////////////
 // HEAP STATISTICS //
/////////////////////
class HeapStat {
 public:
  void Dump(Env env, Object& o, Array& strings) {
    v8::Isolate* isolate = v8::Isolate::GetCurrent();

    const size_t spaces = isolate->NumberOfHeapSpaces();

    auto a = Float64Array::New(env, spaces * 5);

    v8::HeapSpaceStatistics stats;
    for (size_t i = 0; i < spaces; i += 1) {
      auto offset = i * 5;
      if (isolate->GetHeapSpaceStatistics(&stats, i)) {
        a[offset + 0] = InternString(stats.space_name(), strings);
        a[offset + 1] = stats.space_size();
        a[offset + 2] = stats.space_used_size();
        a[offset + 3] = stats.space_available_size();
        a[offset + 4] = stats.physical_space_size();
      } else {
        a[offset + 0] = -1;
      }
    }

    o["heap"] = a;
  }
};


  ///////////////////
 // SPAN TRACKING //
///////////////////
class SpanTracker {
 public:
  ~SpanTracker() {
    Stop();
  }

  uint64_t Track(const Object& span) {
    if (!running_) {
      return -1;
    }

    auto context = span["_spanContext"].As<Object>();
    std::string name = context.Get("_name").As<String>();

    auto id = id_counter_;
    id_counter_ += 1;
    handle_finished_[id] = name;

    unfinished_total_ += 1;
    unfinished_[name] += 1;

    auto tracker = this;
    context.AddFinalizer([id, name, tracker](Env, std::string*) {
      if (tracker->handle_finished_.find(id) == tracker->handle_finished_.end()) {
        tracker->finished_total_ -= 1;
        tracker->finished_[name] -= 1;
      } else {
        tracker->unfinished_total_ -= 1;
        tracker->unfinished_[name] -= 1;
      }
    }, &name);

    return id;
  }

  void Finish(uint64_t id) {
    if (!running_) {
      return;
    }

    unfinished_total_ -= 1;
    finished_total_ += 1;

    std::string name = handle_finished_[id];
    handle_finished_.erase(id);

    if (finished_.find(name) == finished_.end()) {
      finished_.insert(std::make_pair(name, 0));
    }

    unfinished_[name] -= 1;
    finished_[name] += 1;
  }

  void Start() {
    running_ = true;
  }

  void Stop() {
    running_ = false;
    finished_total_ = 0;
    unfinished_total_ = 0;
    finished_.clear();
    unfinished_.clear();
  }

  void Dump(Env env, Object& o, Array& strings) {
    auto a = Float64Array::New(env, 3 + (finished_.size() * 2) + (unfinished_.size() * 2));

    size_t i = 0;

    a[i++] = finished_total_;
    a[i++] = unfinished_total_;

    a[i++] = finished_.size();
    for (auto it : finished_) {
      a[i++] = InternString(it.first, strings);
      a[i++] = it.second;
    }

    for (auto it : unfinished_) {
      a[i++] = InternString(it.first, strings);
      a[i++] = it.second;
    }

    o["spans"] = a;
  }

 private:
  bool running_ = false;
  std::unordered_map<std::string, uint64_t> unfinished_;
  std::unordered_map<std::string, uint64_t> finished_;
  uint64_t unfinished_total_ = 0;
  uint64_t finished_total_ = 0;

  std::unordered_map<uint64_t, std::string> handle_finished_;
  uint64_t id_counter_ = 0;
};


  //////////////////////
 // STATIC INSTANCES //
//////////////////////

static ProcessStat process;
static GCStat gc;
static EventLoopStat ev;
static HeapStat heap;
static SpanTracker spans;


  /////////////////
 // JS BINDINGS //
/////////////////

static bool running = false;

static Value Start(const CallbackInfo& info) {
  if (running) {
    NAPI_THROW(Error::New(info.Env(), "Already started"), {});
  }

  gc.Start();
  ev.Start();
  spans.Start();

  running = true;

  return info.Env().Null();
}

static Value Stop(const CallbackInfo& info) {
  if (!running) {
    NAPI_THROW(Error::New(info.Env(), "Already stopped"), {});
  }

  gc.Start();
  ev.Start();
  spans.Start();

  running = false;

  return info.Env().Null();
}

static Value Dump(const CallbackInfo& info) {
  Env env = info.Env();
  if (!running) {
    NAPI_THROW(Error::New(env, "Not running"), {});
  }

  auto o = Object::New(env);
  auto strings = info[0].As<Array>();

  gc.Dump(env, o);
  spans.Dump(env, o, strings);
  heap.Dump(env, o, strings);

  auto process_a = info[1].As<Float64Array>();
  process.Dump(process_a);

  auto ev_a = info[2].As<Float64Array>();
  ev.Dump(ev_a);

  return o;
}

static Value Track(const CallbackInfo& info) {
  uint64_t id = spans.Track(info[0].As<Object>());
  return Number::New(info.Env(), static_cast<double>(id));
}

static Value Finish(const CallbackInfo& info) {
  double id = info[0].As<Number>();
  spans.Finish(static_cast<uint64_t>(id));
  return info.Env().Null();
}

static Value ClearInternedStrings(const CallbackInfo& info) {
  info[0].As<Array>()["length"] = 0;
  interned_strings.clear();
  return info.Env().Null();
}

Object Init(Env env, Object exports) {
  exports["start"] = Function::New(env, Start);
  exports["stop"] = Function::New(env, Stop);
  exports["dump"] = Function::New(env, Dump);
  exports["track"] = Function::New(env, Track);
  exports["finish"] = Function::New(env, Finish);
  exports["clearInternedStrings"] = Function::New(env, ClearInternedStrings);

  exports["processBuffer"] = Float64Array::New(env, ProcessStat::BufferSize);
  exports["eventLoopBuffer"] = Float64Array::New(env, EventLoopStat::BufferSize);
  exports["strings"] = Array::New(env);

  return exports;
}

NODE_API_MODULE(metrics, Init)
