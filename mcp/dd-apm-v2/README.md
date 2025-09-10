# DD-APM Toolchain v2

A simplified, modular toolchain for creating APM integrations with AI assistance.

## 🎯 Design Philosophy

- **Single Responsibility**: Each tool does one thing well
- **Test-First**: Generate working tests before implementation
- **AI-Assisted**: Leverage AI for pattern matching and gap filling
- **Human-Friendly**: Clean, readable code that engineers can easily modify
- **Maintainable**: Simple architecture for easy porting to other languages

## 🛠️ Tools Overview

### 1. **Analyzer** (`dd-analyze`)
**Purpose**: Static analysis of npm packages to identify instrumentation targets

```bash
cd analyzer
npm install
./bin/dd-analyze.js @clickhouse/client clickhouse-analysis.json
```

**Input**: Package name  
**Output**: Clean JSON with exports, methods, category, dependencies

**Features**:
- ✅ Simple, focused analysis
- ✅ No complex features or LLM calls
- ✅ Fast and reliable
- ✅ Clear JSON output

### 2. **Scaffolder** (`dd-scaffold`)
**Purpose**: Generate clean file structure with stubs, no complex code generation

```bash
cd scaffolder  
npm install
./bin/dd-scaffold.js ../analyzer/clickhouse-analysis.json clickhouse-client
```

**Input**: Analysis JSON + integration name  
**Output**: File structure with TODO comments

**Features**:
- ✅ Modular generators (hooks, plugin, tests, docs, CI)
- ✅ Simple templates, no spaghetti logic
- ✅ TODO-driven development
- ✅ Clean separation of concerns

### 3. **Test Generator** (`dd-test-gen`)
**Purpose**: Generate realistic test scenarios that exercise real package APIs

```bash
cd test-generator
npm install  
./bin/dd-test-gen.js ../analyzer/clickhouse-analysis.json clickhouse-client
```

**Input**: Analysis JSON + integration name  
**Output**: Working test cases with real API usage

**Features**:
- ✅ Category-specific scenarios (database, web, messaging)
- ✅ Real API calls, no mocks
- ✅ Clear span assertions
- ✅ Incremental complexity

### 4. **AI Implementer** (`dd-ai-implement`)
**Purpose**: Fill in instrumentation gaps using AI assistance and existing patterns

```bash
cd ai-implementer
npm install
./bin/dd-ai-implement.js clickhouse-client
```

**Input**: Stubbed files + test scenarios  
**Output**: Working instrumentation that passes tests

**Features**:
- ✅ Pattern-based learning from existing integrations
- ✅ Test-driven implementation
- ✅ Incremental development
- ✅ Validation against test scenarios

## 🚀 Workflow

### Complete Integration Development:

```bash
# 1. Analyze package
cd analyzer
./bin/dd-analyze.js @clickhouse/client clickhouse-analysis.json

# 2. Generate file structure
cd ../scaffolder
./bin/dd-scaffold.js ../analyzer/clickhouse-analysis.json clickhouse-client

# 3. Generate test scenarios
cd ../test-generator
./bin/dd-test-gen.js ../analyzer/clickhouse-analysis.json clickhouse-client

# 4. AI-assisted implementation
cd ../ai-implementer
./bin/dd-ai-implement.js clickhouse-client

# 5. Run tests to validate
npm test packages/datadog-plugin-clickhouse-client
```

## 📁 Generated Structure

```
packages/
├── datadog-instrumentations/src/
│   └── clickhouse-client.js          # Hook registration + TODO stubs
├── datadog-plugin-clickhouse-client/
│   ├── package.json                  # Plugin package
│   ├── src/index.js                  # Plugin class + TODO stubs  
│   └── test/index.spec.js           # Basic test structure
└── clickhouse-client-test-scenarios.js  # Realistic test scenarios
```

## 🔄 Key Improvements over v1

### **Simplified Architecture**
- ❌ **v1**: Complex, interdependent spaghetti code
- ✅ **v2**: Modular, single-purpose tools

### **Better Code Generation**  
- ❌ **v1**: Tries to generate working code, often wrong
- ✅ **v2**: Generates stubs with clear TODOs

### **Test-First Development**
- ❌ **v1**: Tests generated after implementation
- ✅ **v2**: Realistic test scenarios drive implementation

### **AI Integration**
- ❌ **v1**: No AI assistance
- ✅ **v2**: AI fills gaps using existing patterns

### **Maintainability**
- ❌ **v1**: Hard to modify, debug, or port
- ✅ **v2**: Clean, readable, easily extensible

## 🎯 Benefits

### **For Engineers**
- Clean, understandable generated code
- Clear TODO comments guide implementation
- Test scenarios validate behavior
- Easy to debug and modify

### **For AI Assistance**
- Clear success criteria (tests must pass)
- Pattern matching from existing integrations
- Incremental implementation approach
- Focused on filling specific gaps

### **For Maintenance**
- Simple tool architecture
- Well-defined input/output contracts
- Easy to port to other languages
- Minimal business logic complexity

## 🔮 Future Enhancements

1. **Enhanced Pattern Recognition**: Better learning from existing integrations
2. **Multi-Language Support**: Port tools to Python, Java, etc.
3. **Integration Testing**: Automated validation against real services
4. **Performance Analysis**: Built-in overhead measurement
5. **Documentation Generation**: Auto-generate integration guides

## 🚨 Migration from v1

The v1 tools are preserved in:
- `mcp/dd-apm-analyze-v1-backup/`
- `mcp/dd-apm-scaffold-v1-backup/`

v2 tools are completely independent and can be used alongside v1 for comparison.
