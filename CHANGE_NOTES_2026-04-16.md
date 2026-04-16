# 2026-04-16 Change Notes

`mem0` was not available in this environment, so this file records the requested memory note.

## Summary

This change set combines two threads of work:

1. Frontend/app-shell integration work to wire in the MsBrowser React/Vite UI stack.
2. Backend/native-library stabilization work to make `.mzML` loading work again in the Tauri + Rust + C# architecture.

## Backend fixes made

- Added stronger runtime path handoff from Rust to C# via `TAURICS_NATIVES_DIR` in `src-tauri/src/lib.rs`.
- Updated `src-csharp/Native/ImspConverter/NativeEntry.cs` to resolve the actual `natives/` directory from the host, instead of guessing from the process path.
- Added input validation and better exception-chain reporting for `.mzML` conversion failures.
- Added explicit dependency handling for libraries mzLib loads dynamically at runtime.
- Staged and bundled these sidecar files in `natives/` and `src-tauri/natives/`:
  - `System.Data.SQLite.dll`
  - `Microsoft.Data.Sqlite.dll`
  - `SQLitePCLRaw.core.dll`
  - `SQLitePCLRaw.provider.e_sqlite3.dll`
  - `SQLitePCLRaw.batteries_v2.dll`
  - `libe_sqlite3.dylib`
  - `ThermoFisher.CommonCore.*.dll`
  - `Readers.XmlSerializers.dll`
- Added explicit `Microsoft.Data.Sqlite` package usage in `ImspConverter` because the updated `Readers.dll` now depends on that assembly name.

## Why the final worker-process design exists

The biggest blocker was that mzLib's plain `.mzML` parsing path uses `XmlSerializer` over `Readers.Generated.mzMLType`, and that path was not reliable under the Native AOT-loaded `ImspConverter` library.

Symptoms seen during debugging:

- `Could not find file 'System.Data.SQLite'`
- `Could not find file 'ThermoFisher.CommonCore.Data'`
- `Could not find file 'Microsoft.Data.Sqlite'`
- `Readers.Generated.mzMLType cannot be serialized because it does not have a parameterless constructor`

The serializer error was the key architectural issue. Rather than keep fighting Native AOT serializer behavior, the solution was:

- Keep the Tauri-exposed `ImspConverter` Native AOT shim.
- Move the actual `.mzML` conversion work into `src-csharp/Tools/ImspConverterWorker/`.
- Have `NativeEntry.Execute()` shell out to the regular .NET worker executable in `natives/ImspConverterWorker`.

This preserves the current app interface while avoiding the Native AOT `XmlSerializer` failure mode.

## Tests and verification added

- Added/updated Rust integration coverage in `src-tauri/tests/imsp_converter_integration.rs`.
- Verified the converter integration tests pass after staging the worker and sidecar dependencies.
- Confirmed the worker executable is copied into both `natives/` and `src-tauri/natives/` by `src-tauri/build.rs`.

## Things to watch for in the future

- `src-csharp/lib/mzLib/Readers.dll` is now a moving integration point. If it changes again, re-check which SQLite provider and auxiliary DLLs it expects.
- Do not assume Native AOT can safely run reflection-heavy or `XmlSerializer`-heavy mzLib code paths in-process.
- If `.mzML` loading breaks again, first verify:
  - `natives/ImspConverterWorker` exists
  - `src-tauri/natives/ImspConverterWorker` exists
  - the SQLite and Thermo sidecar DLLs are staged in both native directories
- The worker currently depends on the normal .NET runtime packaging path, not the Native AOT path. Changes to `build.rs` or publish settings can silently break that handoff.
- `Readers.XmlSerializers.dll` is part of the workaround surface. If `Readers.dll` changes significantly, regenerate or revalidate that serializer assembly.
- There were parallel changes in this branch. Before refactoring converter code, check whether another change also modified `Readers.dll`, SQLite provider choice, or frontend bootstrapping.

## Recommended future cleanup

- Add a dedicated test that asserts the worker subprocess path is used for `.mzML` conversion.
- Consider documenting the worker-process design in `CLAUDE.md` or project docs so future changes do not accidentally fold conversion back into Native AOT.
- Consider making the sidecar dependency list data-driven by RID/platform so macOS, Linux, and Windows native payloads stay aligned.
