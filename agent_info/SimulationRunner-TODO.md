# SimulationRunner Native Library — TODO

A TauriCS native library for triggering top-down MS1 simulation from the frontend has **not been started**.

## Prerequisite

The mzLib `TopDownSimulator` (at `mzLib/TopDownSimulator/`) does not yet have a clean public
entry point designed for external callers. Before this library can be scaffolded, a service-layer
API needs to be defined in mzLib — similar to how `MzmlImspExportService` wraps the IMSP writer.

## When Ready, Follow the ImspConverter Pattern

1. `npm run cs:make SimulationRunner`
2. Reference mzLib simulation DLLs via `<HintPath>` in the `.csproj`
3. Add `TrimmerRoots.xml` preserving mzLib simulation assemblies
4. Implement `NativeEntry.Execute` — accept JSON request, call mzLib service, return JSON response
5. Add `ALLOWED_PROCESSES = { "taurics.exe", "taurics" }`
6. Write an xUnit test in `src-csharp/Tests/` before wiring the Tauri command

## Likely Request Shape

```json
{
  "ProteoformId": "...",
  "Charge": 10,
  "RetentionTime": 5.2,
  "OutputMzmlPath": "/path/to/simulated.mzML"
}
```

(Exact shape depends on what the mzLib API exposes once it's defined.)

## Reference

- ImspConverter implementation: `src-csharp/Native/ImspConverter/NativeEntry.cs`
- Integration guide: `agent_info/MsBrowser-Integration-Plan.md`
- mzLib simulator status: `/Users/alex/Projects/mzLib/agent_info/TopDown-Simulator-Status.md`
