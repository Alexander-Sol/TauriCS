import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Tauri core module before any imports that use it.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';

// Thin helper that mirrors what the real frontend will do:
// call call_backend with nativeName='imspconverter' and a JSON payload.
async function convertMzml(mzmlPath, outputPath = null) {
  const payload = JSON.stringify({ MzmlPath: mzmlPath, OutputPath: outputPath });
  const responseJson = await invoke('call_backend', {
    nativeName: 'imspconverter',
    jsonData: payload,
  });
  return JSON.parse(responseJson);
}

describe('ImspConverter frontend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ImspPath on success', async () => {
    invoke.mockResolvedValueOnce(
      JSON.stringify({ ImspPath: '/tmp/sample.imsp', Error: null })
    );

    const result = await convertMzml('/data/sample.mzML');

    expect(invoke).toHaveBeenCalledWith('call_backend', {
      nativeName: 'imspconverter',
      jsonData: JSON.stringify({ MzmlPath: '/data/sample.mzML', OutputPath: null }),
    });
    expect(result.ImspPath).toBe('/tmp/sample.imsp');
    expect(result.Error).toBeNull();
  });

  it('surfaces Error field when backend reports a failure', async () => {
    invoke.mockResolvedValueOnce(
      JSON.stringify({ ImspPath: null, Error: 'MzmlPath is required.' })
    );

    const result = await convertMzml('');
    expect(result.Error).toBe('MzmlPath is required.');
    expect(result.ImspPath).toBeNull();
  });

  it('propagates invoke rejection (e.g. library not loaded)', async () => {
    invoke.mockRejectedValueOnce(new Error("Native library 'imspconverter' not found."));

    await expect(convertMzml('/data/sample.mzML')).rejects.toThrow('not found');
  });

  it('forwards custom outputPath to backend', async () => {
    invoke.mockResolvedValueOnce(
      JSON.stringify({ ImspPath: '/custom/out.imsp', Error: null })
    );

    await convertMzml('/data/sample.mzML', '/custom/out.imsp');

    const calledWith = JSON.parse(invoke.mock.calls[0][1].jsonData);
    expect(calledWith.OutputPath).toBe('/custom/out.imsp');
  });
});
