import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  createImspDatasetProvider,
  type DatasetProvider,
  type ScanSummary,
  type TicPoint,
} from "@msbrowser/imsp-core";
import type { TicPlotPoint } from "@msbrowser/plot-adapter";
import type { ViewerDataset } from "@msbrowser/viewer-state";

interface ImspConverterResponse {
  ImspPath: string | null;
  Error: string | null;
}

export interface LoadedDataset {
  fileName: string;
  provider: DatasetProvider;
  metadata: Awaited<ReturnType<DatasetProvider["getMetadata"]>>;
  scanSummaries: readonly ScanSummary[];
  ticTrace: readonly TicPoint[];
}

export interface LoadedViewerDataset {
  loadedDataset: LoadedDataset;
  viewerDataset: ViewerDataset;
}

/** Opens a native file dialog, converts the selected mzML to imsp, and returns a loaded dataset. */
export async function openMzmlAndLoad(): Promise<LoadedViewerDataset | null> {
  const mzmlPath = await openDialog({
    multiple: false,
    filters: [{ name: "mzML Files", extensions: ["mzML", "mzml"] }],
  });

  if (!mzmlPath || typeof mzmlPath !== "string") return null;

  // Convert mzML → imsp via C# backend.
  const responseJson = await invoke<string>("call_backend", {
    nativeName: "imspconverter",
    jsonData: JSON.stringify({ MzmlPath: mzmlPath }),
  });
  const { ImspPath, Error: error }: ImspConverterResponse =
    JSON.parse(responseJson);
  if (error) throw new Error(error);
  if (!ImspPath) throw new Error("Converter returned no output path");

  // Read the imsp file as binary via the Rust read_imsp_file command.
  const buffer = await invoke<ArrayBuffer>("read_imsp_file", { path: ImspPath });
  const provider = createImspDatasetProvider(buffer);

  const [metadata, scanSummaries, ticTrace] = await Promise.all([
    provider.getMetadata(),
    provider.getScanSummaries(),
    provider.getTicTrace(),
  ]);

  const fileName =
    mzmlPath.replace(/\\/g, "/").split("/").pop() ?? mzmlPath;

  return {
    loadedDataset: { fileName, provider, metadata, scanSummaries, ticTrace },
    viewerDataset: {
      metadata: {
        retentionTimeRange: metadata.retentionTimeRange,
        mzRange: metadata.mzRange,
        scanCount: metadata.scanCount,
      },
      scanSummaries: scanSummaries.map((s) => ({
        scanIndex: s.scanIndex,
        oneBasedScanNumber: s.oneBasedScanNumber,
        retentionTime: s.retentionTime,
        tic: s.tic,
      })),
    },
  };
}

export function toTicPlotPoints(
  ticTrace: readonly TicPoint[]
): readonly TicPlotPoint[] {
  return ticTrace.map((p) => ({
    scanIndex: p.scanIndex,
    retentionTime: p.retentionTime,
    intensity: p.tic,
  }));
}

export function formatNumber(
  value: number | undefined,
  decimals: number,
  suffix?: string
): string {
  if (value === undefined) return "—";
  return `${value.toFixed(decimals)}${suffix ? ` ${suffix}` : ""}`;
}

export function formatRange(
  range: { min: number; max: number } | null,
  decimals: number,
  suffix?: string
): string {
  if (!range) return "Full range";
  return `${formatNumber(range.min, decimals, suffix)} to ${formatNumber(range.max, decimals, suffix)}`;
}
