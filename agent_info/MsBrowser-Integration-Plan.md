# MsBrowser → TauriCS Integration Plan

## What MsBrowser Is

A Bun monorepo with four packages and a Next.js 15 web app:

| Package | What it does | Dependencies |
|---|---|---|
| `imsp-core` | Binary `.imsp` parser + `DatasetProvider` interface | **None** (pure TS) |
| `viewer-state` | Zustand command/reducer store | Zustand only (no React) |
| `plot-adapter` | Plotly TIC + Spectrum plot components | **React 19** + Plotly.js |
| `ui` | Layout shell, panels, buttons | **React 19** |

The `web` app (Next.js 15) is not directly embeddable in Tauri and should not be used as-is.

---

## The Core Problem

TauriCS currently has **no frontend bundler** — `src/` is static vanilla JS loaded directly by
Tauri's webview. The MsBrowser packages are TypeScript and require a build step. This must be
resolved before any package integration is possible.

---

## Step 1 — Add Vite + React to TauriCS

This is the standard Tauri v2 frontend setup and a prerequisite for everything else.

```bash
npm install -D vite @vitejs/plugin-react
npm install react react-dom
```

- Create `vite.config.js` at the project root
- Update `tauri.conf.json`: set `devUrl` to `http://localhost:5173` and `beforeDevCommand: "npm run dev"`
- Add `"dev": "vite"` and `"build": "vite build"` to `package.json` scripts
- Replace `src/index.html` as the Vite entry point

---

## Step 2 — Link MsBrowser Packages

Reference the local MsBrowser monorepo packages directly via `file:` links — no copying or
publishing needed. Vite will transpile them.

In TauriCS `package.json`:

```json
"dependencies": {
  "@msbrowser/imsp-core":    "file:../MsBrowser/packages/imsp-core",
  "@msbrowser/viewer-state": "file:../MsBrowser/packages/viewer-state",
  "@msbrowser/plot-adapter": "file:../MsBrowser/packages/plot-adapter",
  "@msbrowser/ui":           "file:../MsBrowser/packages/ui"
}
```

Run `npm install` after adding these.

---

## Step 3 — Wire the Data Flow

The integration seam is `createImspDatasetProvider(buffer: ArrayBuffer)` from `imsp-core`.

### Recommended: file path (large files)

1. Frontend calls `invoke('call_backend', { nativeName: 'imspconverter', jsonData: JSON.stringify({ MzmlPath, OutputPath }) })`
2. C# backend writes `.imsp` to disk and returns `{ ImspPath: "/path/to/file.imsp" }`
3. Frontend reads the file via Tauri's `fs` plugin: `readFile(imspPath)` → `Uint8Array` → `.buffer` → `ArrayBuffer`
4. Pass to `createImspDatasetProvider(buffer)` → `DatasetProvider`
5. Feed `DatasetProvider` into `TicPlot` / `SpectrumPlot`

### Alternative: bytes in memory (small files only)

C# returns base64-encoded bytes; frontend decodes to `ArrayBuffer`. Avoid for files over ~50MB.
The Jurkat dataset produces ~50MB IMSP, so the file-path approach is safer.

---

## Step 4 — Compose the UI

Use `apps/web/app/viewer-page.tsx` and `viewer-controller.ts` in MsBrowser as the
**implementation reference** — they show exactly how `imsp-core` → `viewer-state` →
`plot-adapter` wire together. The components import cleanly once Vite + React are in place.

Key pieces:
- `createViewerStore()` from `viewer-state` — initialise once, pass down via props or context
- `loadViewerDataset(file)` in `viewer-controller.ts` — shows how to go from file/buffer → `LoadedDataset`
- `TicPlot` / `SpectrumPlot` from `plot-adapter` — drop-in React components, handle Plotly internally
- `ViewerShell` / `Panel` / `PanelHeader` from `ui` — optional layout wrappers

---

## What to Skip

| Thing | Why |
|---|---|
| Web Worker setup (`imsp-worker.ts`, `worker-dataset-provider.ts`) | IMSP parses in <100ms in main thread; not needed in Tauri |
| Next.js app router, layouts, `page.tsx` | Not relevant in Tauri |
| `DatasetProvider` reimplementation | `createImspDatasetProvider(buffer)` is sufficient |

---

## MsBrowser Architecture Reference

### `imsp-core` DatasetProvider interface

```typescript
interface DatasetProvider {
  getMetadata(): Promise<DatasetMetadata>
  getScanSummaries(): Promise<readonly ScanSummary[]>
  getNearestScan(retentionTime: number): Promise<ScanSummary | null>
  getSpectrumForScan(scanIndex: number): Promise<Spectrum>
  getPeaksInMzRange(mzMin: number, mzMax: number): Promise<readonly ImspPeak[]>
  getTicTrace(rtRange?: NumericRange): Promise<readonly TicPoint[]>
}
```

### `viewer-state` store commands (discriminated union)

- `dataset/load-started`, `load-succeeded`, `load-failed`
- `selection/set-scan`, `select-nearest-scan`
- `panel/set-active`, `set-pinned`, `toggle-pinned`, `zoom`, `reset`

### State flow on scan selection

1. User clicks TIC plot → `area-click` event
2. Dispatch `selection/select-nearest-scan` → `selectedScanIndex` updated
3. `useEffect` detects change → `provider.getSpectrumForScan(scanIndex)`
4. Re-render `SpectrumPlot` with new trace

---

## Existing Backend (imsp-integration branch)

The `ImspConverter` native library is already implemented and tested:

- **Library name**: `imspconverter`
- **Command**: `invoke('call_backend', { nativeName: 'imspconverter', jsonData })`
- **Request**: `{ MzmlPath: string, OutputPath?: string }`
- **Response**: `{ ImspPath: string | null, Error: string | null }`
- **xUnit test**: `src-csharp/Tests/ImspConverterTests/` — passes against the Jurkat mzML
