import React, {
  useEffect,
  useState,
  useSyncExternalStore,
  startTransition,
  type CSSProperties,
} from "react";
import {
  TicPlot,
  SpectrumPlot,
  type SlotIndex,
  type SpectrumPlotTrace,
  type TicPlotTrace,
  type TicPlotPoint,
} from "@msbrowser/plot-adapter";
import {
  MetricReadout,
  Panel,
  PanelActionButton,
  PanelHeader,
  StatusBanner,
  ViewerShell,
  WorkspaceBadge,
} from "@msbrowser/ui";
import {
  createViewerStore,
  type ViewerStore,
} from "@msbrowser/viewer-state";
import type { Spectrum } from "@msbrowser/imsp-core";

import {
  openMzmlAndLoad,
  toTicPlotPoints,
  formatNumber,
  formatRange,
  type LoadedDataset,
} from "./tauri-controller";

const SLOT_COLORS: [string, string] = ["#2563eb", "#dc2626"];
const DEFAULT_SPECTRUM_RANGE = { min: 200, max: 1200 };

type DatasetPair = [LoadedDataset | null, LoadedDataset | null];
type SpectrumPair = [Spectrum | null, Spectrum | null];

export function App() {
  const [viewerStore] = useState<ViewerStore>(() => createViewerStore());
  const viewerState = useViewerState(viewerStore);
  const [loadedDatasets, setLoadedDatasets] = useState<DatasetPair>([
    null,
    null,
  ]);
  const [selectedSpectra, setSelectedSpectra] = useState<SpectrumPair>([
    null,
    null,
  ]);
  const [hoveredTicPoint, setHoveredTicPoint] =
    useState<TicPlotPoint | null>(null);
  const [hoveredSpectrumPeak, setHoveredSpectrumPeak] = useState<
    SpectrumPlotTrace["peaks"][number] | null
  >(null);

  const ticViewport = toViewport(viewerState.ticPanel.range);
  const spectrumRange =
    viewerState.spectrumPanel.range ?? DEFAULT_SPECTRUM_RANGE;
  const spectrumViewport = toViewport(spectrumRange);

  const slot0 = viewerState.datasetSlots[0];
  const slot1 = viewerState.datasetSlots[1];

  const scanSummary0 =
    loadedDatasets[0] && slot0.selectedScanIndex !== null
      ? loadedDatasets[0].scanSummaries[slot0.selectedScanIndex] ?? null
      : null;
  const scanSummary1 =
    loadedDatasets[1] && slot1.selectedScanIndex !== null
      ? loadedDatasets[1].scanSummaries[slot1.selectedScanIndex] ?? null
      : null;

  // Load spectrum for slot 0 when its selected scan changes.
  useEffect(() => {
    const idx = slot0.selectedScanIndex;
    if (!loadedDatasets[0] || idx === null) {
      setSelectedSpectra((prev) => [null, prev[1]]);
      return;
    }
    let cancelled = false;
    void loadedDatasets[0].provider.getSpectrumForScan(idx).then((spectrum) => {
      if (!cancelled) setSelectedSpectra((prev) => [spectrum, prev[1]]);
    });
    return () => {
      cancelled = true;
    };
  }, [loadedDatasets[0], slot0.selectedScanIndex]);

  // Load spectrum for slot 1 when its selected scan changes.
  useEffect(() => {
    const idx = slot1.selectedScanIndex;
    if (!loadedDatasets[1] || idx === null) {
      setSelectedSpectra((prev) => [prev[0], null]);
      return;
    }
    let cancelled = false;
    void loadedDatasets[1].provider.getSpectrumForScan(idx).then((spectrum) => {
      if (!cancelled) setSelectedSpectra((prev) => [prev[0], spectrum]);
    });
    return () => {
      cancelled = true;
    };
  }, [loadedDatasets[1], slot1.selectedScanIndex]);

  // Build TIC traces.
  const ticTraces: TicPlotTrace[] = [];
  if (loadedDatasets[0]) {
    ticTraces.push({
      slotIndex: 0,
      points: toTicPlotPoints(loadedDatasets[0].ticTrace),
      selectedScanIndex: slot0.selectedScanIndex,
      color: SLOT_COLORS[0],
    });
  }
  if (loadedDatasets[1]) {
    ticTraces.push({
      slotIndex: 1,
      points: toTicPlotPoints(loadedDatasets[1].ticTrace),
      selectedScanIndex: slot1.selectedScanIndex,
      color: SLOT_COLORS[1],
    });
  }

  // Build spectrum traces.
  const spectrumTraces: SpectrumPlotTrace[] = [];
  if (selectedSpectra[0]) {
    spectrumTraces.push({
      slotIndex: 0,
      peaks: selectedSpectra[0].peaks.map((p) => ({
        mz: p.mz,
        intensity: p.intensity,
      })),
      color: SLOT_COLORS[0],
    });
  }
  if (selectedSpectra[1]) {
    spectrumTraces.push({
      slotIndex: 1,
      peaks: selectedSpectra[1].peaks.map((p) => ({
        mz: p.mz,
        intensity: p.intensity,
      })),
      color: SLOT_COLORS[1],
    });
  }

  const neitherLoaded =
    slot0.load.status !== "loading" &&
    slot0.load.status !== "ready" &&
    slot1.load.status !== "loading" &&
    slot1.load.status !== "ready";

  async function handleOpen(slotIndex: SlotIndex) {
    viewerStore.getState().dispatch({ type: "dataset/load-started", slotIndex });
    setHoveredTicPoint(null);
    setHoveredSpectrumPeak(null);

    try {
      const result = await openMzmlAndLoad();
      if (!result) {
        // User cancelled the dialog — revert loading state.
        viewerStore.getState().dispatch({
          type: "dataset/load-failed",
          slotIndex,
          errorMessage: "Cancelled",
        });
        return;
      }

      const { loadedDataset, viewerDataset } = result;
      startTransition(() => {
        setLoadedDatasets((prev) => {
          const next: DatasetPair = [prev[0], prev[1]];
          next[slotIndex] = loadedDataset;
          return next;
        });
        viewerStore.getState().dispatch({
          type: "dataset/load-succeeded",
          slotIndex,
          dataset: viewerDataset,
        });
        if (viewerDataset.scanSummaries.length > 0) {
          viewerStore.getState().dispatch({
            type: "selection/set-scan",
            slotIndex,
            scanIndex: 0,
          });
        }
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load dataset";
      startTransition(() => {
        setLoadedDatasets((prev) => {
          const next: DatasetPair = [prev[0], prev[1]];
          next[slotIndex] = null;
          return next;
        });
        viewerStore.getState().dispatch({
          type: "dataset/load-failed",
          slotIndex,
          errorMessage: message,
        });
      });
    }
  }

  const slotLabels = ["A", "B"] as const;

  return (
    <ViewerShell
      title="IMSP Viewer"
      subtitle="Open one or two .mzML files to convert and compare their TIC and spectra."
      toolbar={
        <>
          <OpenMzmlButton
            label="Open mzML (A)"
            color={SLOT_COLORS[0]}
            onClick={() => void handleOpen(0)}
          />
          <WorkspaceBadge
            label={
              loadedDatasets[0]
                ? loadedDatasets[0].fileName
                : slot0.load.status
            }
          />
          <OpenMzmlButton
            label="Open mzML (B)"
            color={SLOT_COLORS[1]}
            onClick={() => void handleOpen(1)}
          />
          <WorkspaceBadge
            label={
              loadedDatasets[1]
                ? loadedDatasets[1].fileName
                : slot1.load.status
            }
          />
        </>
      }
    >
      {([slot0, slot1] as const).map((slot, i) =>
        slot.load.status === "loading" ? (
          <StatusBanner tone="info" key={i}>
            Dataset {slotLabels[i]}: Converting and loading…
          </StatusBanner>
        ) : slot.load.status === "error" &&
          slot.load.errorMessage !== "Cancelled" ? (
          <StatusBanner tone="error" key={i}>
            Dataset {slotLabels[i]}: {slot.load.errorMessage}
          </StatusBanner>
        ) : null
      )}
      {neitherLoaded && (
        <StatusBanner tone="muted">
          Use the buttons above to open a .mzML file. It will be converted to
          .imsp and displayed here.
        </StatusBanner>
      )}

      <Panel
        header={
          <PanelHeader
            title="Total Ion Chromatogram"
            subtitle="Click to select a scan. Pin to drag-zoom retention time."
            readouts={
              <>
                <MetricReadout
                  label="A: Scan"
                  value={scanSummary0?.oneBasedScanNumber ?? "—"}
                />
                <MetricReadout
                  label="B: Scan"
                  value={scanSummary1?.oneBasedScanNumber ?? "—"}
                />
                <MetricReadout
                  label="Hover RT"
                  value={formatNumber(
                    hoveredTicPoint?.retentionTime,
                    3,
                    "min"
                  )}
                />
                <MetricReadout
                  label="View"
                  value={formatRange(viewerState.ticPanel.range, 3, "min")}
                />
              </>
            }
            actions={
              <>
                <PanelActionButton
                  onClick={() =>
                    viewerStore
                      .getState()
                      .dispatch({ type: "panel/toggle-pinned", panelId: "tic" })
                  }
                  pressed={viewerState.ticPanel.pinned}
                >
                  Pin Zoom
                </PanelActionButton>
                <PanelActionButton
                  onClick={() =>
                    viewerStore
                      .getState()
                      .dispatch({ type: "panel/reset", panelId: "tic" })
                  }
                >
                  Reset
                </PanelActionButton>
              </>
            }
          />
        }
      >
        {ticTraces.length > 0 ? (
          <TicPlot
            traces={ticTraces}
            viewport={ticViewport}
            rangeSelectionEnabled={viewerState.ticPanel.pinned}
            onEvent={(event) => {
              if (event.type === "area-click") {
                const { retentionTime } = event;
                const currentState = viewerStore.getState();
                (([0, 1]) as SlotIndex[]).forEach((slotIndex) => {
                  if (
                    currentState.datasetSlots[slotIndex].load.status === "ready"
                  ) {
                    viewerStore.getState().dispatch({
                      type: "selection/select-nearest-scan",
                      slotIndex,
                      retentionTime,
                    });
                  }
                });
                if (!viewerStore.getState().spectrumPanel.pinned) {
                  viewerStore
                    .getState()
                    .dispatch({ type: "panel/reset", panelId: "spectrum" });
                }
                setHoveredSpectrumPeak(null);
                return;
              }
              if (event.type === "point-hover") {
                setHoveredTicPoint(event.point);
                return;
              }
              viewerStore
                .getState()
                .dispatch({
                  type: "panel/zoom",
                  panelId: "tic",
                  range: event.range,
                });
            }}
          />
        ) : (
          <StatusBanner tone="muted">
            The TIC will appear here after you load a dataset.
          </StatusBanner>
        )}
      </Panel>

      <Panel
        header={
          <PanelHeader
            title="Mass Spectrum"
            subtitle="The selected scan is reconstructed on demand. Pin to drag-zoom m/z."
            readouts={
              <>
                <MetricReadout
                  label="A: RT"
                  value={formatNumber(
                    scanSummary0?.retentionTime,
                    3,
                    "min"
                  )}
                />
                <MetricReadout
                  label="B: RT"
                  value={formatNumber(
                    scanSummary1?.retentionTime,
                    3,
                    "min"
                  )}
                />
                <MetricReadout
                  label="Hover m/z"
                  value={formatNumber(hoveredSpectrumPeak?.mz, 4)}
                />
                <MetricReadout
                  label="View"
                  value={formatRange(spectrumRange, 4)}
                />
              </>
            }
            actions={
              <>
                <PanelActionButton
                  onClick={() =>
                    viewerStore
                      .getState()
                      .dispatch({
                        type: "panel/toggle-pinned",
                        panelId: "spectrum",
                      })
                  }
                  pressed={viewerState.spectrumPanel.pinned}
                >
                  Pin Zoom
                </PanelActionButton>
                <PanelActionButton
                  onClick={() =>
                    viewerStore
                      .getState()
                      .dispatch({ type: "panel/reset", panelId: "spectrum" })
                  }
                >
                  Reset
                </PanelActionButton>
              </>
            }
          />
        }
      >
        {spectrumTraces.length > 0 ? (
          <SpectrumPlot
            traces={spectrumTraces}
            viewport={spectrumViewport}
            rangeSelectionEnabled={viewerState.spectrumPanel.pinned}
            onEvent={(event) => {
              if (event.type === "point-hover") {
                setHoveredSpectrumPeak(event.peak);
                return;
              }
              viewerStore
                .getState()
                .dispatch({
                  type: "panel/zoom",
                  panelId: "spectrum",
                  range: event.range,
                });
            }}
          />
        ) : (
          <StatusBanner tone="muted">
            Select a scan in the TIC to reconstruct and display its spectrum.
          </StatusBanner>
        )}
      </Panel>
    </ViewerShell>
  );
}

function useViewerState(viewerStore: ViewerStore) {
  return useSyncExternalStore(
    viewerStore.subscribe,
    viewerStore.getState,
    viewerStore.getState
  );
}

function toViewport(range: { min: number; max: number } | null) {
  return {
    xMin: range?.min ?? null,
    xMax: range?.max ?? null,
  };
}

function OpenMzmlButton({
  label,
  color,
  onClick,
}: {
  label: string;
  color: string;
  onClick: () => void;
}) {
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 44,
    borderRadius: 999,
    padding: "0 1rem",
    border: `1px solid ${color}`,
    background: `linear-gradient(180deg, ${color} 0%, ${darken(color)} 100%)`,
    color: "#ffffff",
    fontWeight: 700,
    cursor: "pointer",
    fontSize: "inherit",
    whiteSpace: "nowrap",
  };

  return (
    <button type="button" style={style} onClick={onClick}>
      {label}
    </button>
  );
}

function darken(hex: string): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = Math.max(0, ((n >> 16) & 0xff) - 38);
  const g = Math.max(0, ((n >> 8) & 0xff) - 38);
  const b = Math.max(0, (n & 0xff) - 38);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
