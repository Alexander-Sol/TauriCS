using System.IO;
using Readers;
using Xunit.Abstractions;

namespace ImspConverterTests;

public class ImspConverterTest(ITestOutputHelper output)
{
    private const string MzmlPath = "/Users/alex/Downloads/02-18-20_jurkat_td_rep2_fract7.mzML";

    [Fact]
    public void ConvertMzmlToImsp_WritesFileAndFirstThreeScansHaveRetentionTimes()
    {
        Assert.True(File.Exists(MzmlPath), $"mzML file not found: {MzmlPath}");

        var service = new MzmlImspExportService();
        string imspPath = service.ConvertToImspFile(MzmlPath);

        output.WriteLine($"IMSP file: {imspPath}");
        Assert.True(File.Exists(imspPath), "IMSP file was not created");

        // Parse the scan table directly from the binary format (IMSP_Format.md)
        using var fs = new FileStream(imspPath, FileMode.Open, FileAccess.Read);
        using var reader = new BinaryReader(fs);

        // Header (24 bytes)
        byte[] magic = reader.ReadBytes(4);
        Assert.Equal("IMSP", System.Text.Encoding.ASCII.GetString(magic));

        uint version          = reader.ReadUInt32();
        uint binsPerDalton    = reader.ReadUInt32();
        uint nonEmptyBinCount = reader.ReadUInt32();
        uint totalPeakCount   = reader.ReadUInt32();
        uint scanCount        = reader.ReadUInt32();

        output.WriteLine($"Version: {version}, Scans: {scanCount}, Bins: {nonEmptyBinCount}, Peaks: {totalPeakCount}");
        Assert.True(scanCount >= 3, $"Expected at least 3 scans, got {scanCount}");

        // Scan table: S × 16 bytes (uint32 scanNumber + float64 RT + float32 TIC)
        int scansToRead = (int)Math.Min(3, scanCount);
        for (int i = 0; i < scansToRead; i++)
        {
            uint   scanNumber    = reader.ReadUInt32();
            double retentionTime = reader.ReadDouble();
            float  tic           = reader.ReadSingle();

            output.WriteLine($"  Scan[{i}]: #{scanNumber}  RT={retentionTime:F4} min  TIC={tic:E3}");

            Assert.True(retentionTime >= 0, $"Scan {i} has negative retention time");
        }
    }
}
