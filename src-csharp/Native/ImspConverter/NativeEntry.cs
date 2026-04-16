using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Globals;
using Readers;

namespace ImspConverter;

public class ConvertRequest
{
    public string? MzmlPath { get; set; }
    public string? OutputPath { get; set; }
}

public class ConvertResponse
{
    public string? ImspPath { get; set; }
    public string? Error { get; set; }
}

[JsonSerializable(typeof(ConvertRequest))]
[JsonSerializable(typeof(ConvertResponse))]
public partial class NativeJsonContext : JsonSerializerContext { }

public static class NativeEntry
{
    // Allow both the Windows exe name and the macOS/Linux binary name.
    private static readonly string[] ALLOWED_PROCESSES = { "taurics.exe", "taurics" };

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    delegate void ProgressCallback(IntPtr message);

    [UnmanagedCallersOnly(EntryPoint = "get_native_name")]
    public static IntPtr GetNativeName() =>
        Marshal.StringToCoTaskMemUTF8("imspconverter");

    [UnmanagedCallersOnly(EntryPoint = "free_string")]
    public static void FreeString(IntPtr ptr) =>
        Marshal.FreeCoTaskMem(ptr);

    [UnmanagedCallersOnly(EntryPoint = "execute")]
    public static IntPtr Execute(IntPtr jsonDataPtr)
    {
        // The Native AOT shim delegates mzML parsing to a regular .NET worker because
        // mzLib's XmlSerializer-based mzML path is not reliable under Native AOT.
        // Point CWD at the same natives/ directory Rust loaded us from so sidecar files
        // remain discoverable for both the shim and the worker process.
        //
        // Note: static constructors are NOT guaranteed to run before [UnmanagedCallersOnly]
        // entry points, so this must live in the method body.
        PointCwdAtNatives();

        var (isVerified, processName) = Security.VerifyCurrentProcess(ALLOWED_PROCESSES);
        if (!isVerified)
            return Respond(error: $"Security check failed: unauthorized process '{processName}'.");

        try
        {
            var json = Marshal.PtrToStringUTF8(jsonDataPtr)!;
            var request = JsonSerializer.Deserialize(json, NativeJsonContext.Default.ConvertRequest);

            if (string.IsNullOrWhiteSpace(request?.MzmlPath))
                return Respond(error: "MzmlPath is required.");

            var inputValidationError = ValidateInputFile(request.MzmlPath);
            if (inputValidationError is not null)
                return Respond(error: inputValidationError);

            return ExecuteWithWorker(request);
        }
        catch (Exception ex)
        {
            return Respond(error: FormatError(ex));
        }
    }

    // Streaming: not applicable for this library; no-op to satisfy the interface.
    [UnmanagedCallersOnly(EntryPoint = "execute_streaming")]
    public static void ExecuteStreaming(IntPtr jsonDataPtr, IntPtr callbackPtr)
    {
        var callback = Marshal.GetDelegateForFunctionPointer<ProgressCallback>(callbackPtr);
        callback(Marshal.StringToCoTaskMemUTF8("__STREAM_END__"));
    }

    // External: not applicable for this library.
    [UnmanagedCallersOnly(EntryPoint = "execute_external")]
    public static IntPtr ExecuteExternal(IntPtr jsonDataPtr) =>
        Respond(error: "execute_external is not supported by ImspConverter.");

    /// <summary>
    /// Sets the process CWD to the natives/ directory used by the Rust host.
    /// Called at the top of every Execute because [UnmanagedCallersOnly] entry points
    /// bypass the type initializer.
    /// </summary>
    private static void PointCwdAtNatives()
    {
        try
        {
            var nativesDir = ResolveNativesDir();
            if (!string.IsNullOrWhiteSpace(nativesDir))
                Environment.CurrentDirectory = nativesDir;
        }
        catch { /* best-effort */ }
    }

    private static string? ResolveNativesDir()
    {
        var configuredNativesDir = Environment.GetEnvironmentVariable("TAURICS_NATIVES_DIR");
        if (!string.IsNullOrWhiteSpace(configuredNativesDir) && Directory.Exists(configuredNativesDir))
            return configuredNativesDir;

        var exePath = Environment.ProcessPath;
        if (string.IsNullOrEmpty(exePath)) return null;
        var nativesDir = Path.Combine(Path.GetDirectoryName(exePath)!, "natives");
        return Directory.Exists(nativesDir) ? nativesDir : null;
    }

    private static IntPtr ExecuteWithWorker(ConvertRequest request)
    {
        var nativesDir = ResolveNativesDir();
        if (string.IsNullOrWhiteSpace(nativesDir))
            return Respond(error: "Could not resolve natives directory for ImspConverter worker.");

        var workerPath = Path.Combine(nativesDir, GetWorkerFileName());
        if (!File.Exists(workerPath))
            return Respond(error: $"ImspConverter worker was not found: '{workerPath}'.");

        var payload = JsonSerializer.Serialize(request, NativeJsonContext.Default.ConvertRequest);
        var startInfo = new System.Diagnostics.ProcessStartInfo
        {
            FileName = workerPath,
            WorkingDirectory = nativesDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        startInfo.ArgumentList.Add(payload);

        using var process = System.Diagnostics.Process.Start(startInfo);
        if (process is null)
            return Respond(error: $"Failed to start ImspConverter worker: '{workerPath}'.");

        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();

        if (process.ExitCode != 0)
            return Respond(error: $"ImspConverter worker exited with code {process.ExitCode}. {stderr}".Trim());

        if (string.IsNullOrWhiteSpace(stdout))
            return Respond(error: $"ImspConverter worker returned no output. {stderr}".Trim());

        var response = JsonSerializer.Deserialize(stdout, NativeJsonContext.Default.ConvertResponse);
        if (response is null)
            return Respond(error: "ImspConverter worker returned invalid JSON.");

        return Respond(imspPath: response.ImspPath, error: string.IsNullOrWhiteSpace(response.Error) ? null : response.Error);
    }

    private static string GetWorkerFileName() =>
        OperatingSystem.IsWindows() ? "ImspConverterWorker.exe" : "ImspConverterWorker";

    private static IntPtr Respond(string? imspPath = null, string? error = null)
    {
        var response = new ConvertResponse { ImspPath = imspPath, Error = error };
        return Marshal.StringToCoTaskMemUTF8(
            JsonSerializer.Serialize(response, NativeJsonContext.Default.ConvertResponse));
    }

    private static string? ValidateInputFile(string mzmlPath)
    {
        try
        {
            if (!File.Exists(mzmlPath))
                return $"Input mzML file was not found: '{mzmlPath}'.";

            var fileInfo = new FileInfo(mzmlPath);
            if (fileInfo.Length == 0)
                return $"Input mzML file is empty: '{mzmlPath}'.";

            using var stream = File.OpenRead(mzmlPath);
            Span<byte> header = stackalloc byte[512];
            int bytesRead = stream.Read(header);
            if (bytesRead >= 2 && header[0] == 0x1F && header[1] == 0x8B)
                return $"Input file appears to be gzipped (.mzML.gz), but the converter only accepts plain .mzML XML files: '{mzmlPath}'.";

            var headerText = Encoding.UTF8.GetString(header[..bytesRead]);
            if (!StartsLikeXml(headerText))
                return $"Input file does not appear to start with mzML/XML content: '{mzmlPath}'.";

            return null;
        }
        catch (Exception ex)
        {
            return $"Failed to inspect input file '{mzmlPath}': {FormatError(ex)}";
        }
    }

    private static bool StartsLikeXml(string text)
    {
        var trimmed = text.TrimStart('\uFEFF', ' ', '\t', '\r', '\n');
        return trimmed.StartsWith("<?xml", StringComparison.Ordinal) || trimmed.StartsWith("<mzML", StringComparison.Ordinal) || trimmed.StartsWith("<indexedmzML", StringComparison.Ordinal);
    }

    private static string FormatError(Exception ex)
    {
        var builder = new StringBuilder();
        Exception? current = ex;
        int depth = 0;
        while (current is not null)
        {
            if (depth > 0)
                builder.Append(" | Inner: ");

            builder.Append(current.GetType().Name);
            builder.Append(": ");
            builder.Append(current.Message);

            current = current.InnerException;
            depth++;
        }

        return builder.ToString();
    }
}
