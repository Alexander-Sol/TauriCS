# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install frontend dependencies
npm install

# Run in development mode (builds C# on first run)
npm run tauri dev

# Build for production (output: src-tauri/target/release/bundle/)
npm run tauri build

# Scaffold a new C# native library (PascalCase name required)
npm run cs:make MyNewLibrary
```

# Run frontend tests (Vitest)
npm test
npm run test:watch

# Run Rust command tests
cd src-tauri && cargo test

# Run C# xUnit tests
dotnet test src-csharp/Tests/ImspConverterTests/

## Architecture

This is a **Tauri v2 desktop app** with a three-layer architecture:

```
JS Frontend (src/) → Rust Core (src-tauri/) → C# Native Libraries (src-csharp/)
```

### Data Flow

The frontend calls one of three Tauri commands, all defined in `src-tauri/src/lib.rs`:

| Tauri command | JS invoke | C# export | Use case |
|---|---|---|---|
| `call_backend` | `invoke('call_backend', ...)` | `execute` | Sync request-response |
| `start_streaming_task` | `invoke('start_streaming_task', ...)` | `execute_streaming` | Long-running tasks with progress |
| `call_backend_external` | `invoke('call_backend_external', ...)` | `execute_external` | Calling other native DLLs from C# |

Streaming responses arrive via the `csharp-stream` Tauri event. The sentinel string `__STREAM_END__` signals end-of-stream.

### Rust Core (`src-tauri/src/lib.rs`)

- Loads all `.dll` files from the `natives/` directory at startup via `libloading`
- Identifies libraries by calling `get_native_name` on each DLL
- Stores loaded libraries in a `NativeManager` (a `Mutex<HashMap<String, Arc<LoadedNative>>>`)
- Libraries that don't export the required symbols (e.g., utility DLLs) are skipped silently
- Two global mutable statics (`APP_HANDLE`, `FREE_STRING_FN`) are used by the streaming callback — this is an intentional unsafe design to cross the FFI boundary

### Automated Build (`src-tauri/build.rs`)

Runs automatically before each Rust compile:
1. Builds `src-csharp/Globals/` with `dotnet build`
2. Publishes every subdirectory of `src-csharp/Native/` as Native AOT with `dotnet publish -r win-x64`
3. Copies output `.dll` files to `natives/` (root staging directory)
4. Syncs `natives/` → `src-tauri/natives/` (the bundled location)

The target RID is derived from `CARGO_CFG_TARGET_OS` and `CARGO_CFG_TARGET_ARCH` at build time, supporting `win-x64/arm64`, `osx-x64/arm64`, and `linux-x64/arm64`.

### C# Libraries (`src-csharp/`)

Each library in `src-csharp/Native/<Name>/` must export these C functions via `[UnmanagedCallersOnly]`:
- `get_native_name` — returns the library's lookup key (lowercase string)
- `free_string` — frees strings allocated by the library
- `execute` — sync call
- `execute_streaming` — receives a function pointer callback; must emit `__STREAM_END__` when done
- `execute_external` — for calling other DLLs

**Globals library** (`src-csharp/Globals/`) is a shared dependency providing:
- `Shared` — shared state across libraries
- `NativeLoader` — dynamic loading of arbitrary external DLLs by name with a function handle cache
- `Security.VerifyCurrentProcess` — checks the host process name against `ALLOWED_PROCESSES`

**Native AOT constraint**: JSON serialization must use source-generated contexts (`[JsonSerializable]` + `JsonSerializerContext`) — reflection-based serialization does not work.

### Adding a New C# Library

```bash
npm run cs:make MyNewLibrary
# Creates src-csharp/Native/MyNewLibrary/ with NativeEntry.cs template
# Next `npm run tauri dev` will compile and load it automatically
```

Update `ALLOWED_PROCESSES` in the generated `NativeEntry.cs` if the app executable name differs.

### Pre-compiled / External DLLs

Drop any platform-native library (`.dll` on Windows, `.dylib` on macOS, `.so` on Linux) into the root `natives/` directory. They will be synced to `src-tauri/natives/` and bundled. If they don't export the required symbols, Rust will skip them silently (logged as "might be a utility DLL"). C# libraries can load these at runtime via `NativeLoader.LoadFunction<T>`.

### Referencing Managed DLLs from a Native AOT Library

When a C# native library needs to call into regular managed assemblies (e.g., mzLib), place the DLLs in `src-csharp/lib/mzLib/` and reference them via `<HintPath>` in the `.csproj`. Because mzLib is not AOT-annotated, add a `TrimmerRoots.xml` that preserves all types, and set `<SuppressTrimAnalysisWarnings>true</SuppressTrimAnalysisWarnings>`. See `src-csharp/Native/ImspConverter/` for a working example.

---

## Testing

### Rust Command Tests (`cargo test`)

Tests live in a `#[cfg(test)]` module at the bottom of `src-tauri/src/lib.rs`. They use `tauri::test::mock_builder()` to spin up a real app instance with managed state but no webview. The `test` feature must be enabled in `Cargo.toml`:

```toml
tauri = { version = "2", features = ["test"] }
```

**Limitation**: `start_streaming_task` takes `AppHandle`, which is not implemented for `MockRuntime`. Register only `call_backend` and `call_backend_external` in the mock invoke handler.

### Frontend Tests (`npm test`)

Vitest + jsdom. Config at `vitest.config.js`. Tests live in `src/__tests__/`. Mock `invoke` with:

```js
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
```

Tests verify the JSON request shape sent to `invoke`, successful response parsing, error field surfacing, and invoke rejections.

### C# Library Tests (`dotnet test`)

xUnit test projects in `src-csharp/Tests/`. These test C# service logic directly without going through the Tauri/Rust layer. Reference mzLib DLLs from `src-csharp/lib/mzLib/` via `<HintPath>`.

`ImspConverterTests` verifies end-to-end: mzML → `.imsp` file, magic bytes, scan count, and first-scan retention times.

---

## ImspConverter Library

`src-csharp/Native/ImspConverter/` — converts `.mzML` files to `.imsp` format using mzLib.

**Request** (JSON passed to `call_backend` with `nativeName: 'imspconverter'`):
```json
{ "MzmlPath": "/path/to/file.mzML", "OutputPath": "/optional/out.imsp" }
```

**Response**:
```json
{ "ImspPath": "/path/to/file.imsp", "Error": null }
```

Output path defaults to the same directory as the input with `.imsp` extension. The IMSP format spec is documented in `/Users/alex/Projects/MsBrowser/IMSP_Format.md`.
