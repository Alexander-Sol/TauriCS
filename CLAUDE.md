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

There are no test commands — this is a template/demo project without a test suite.

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
