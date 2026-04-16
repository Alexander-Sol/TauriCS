using System.Runtime.InteropServices;
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
        var (isVerified, processName) = Security.VerifyCurrentProcess(ALLOWED_PROCESSES);
        if (!isVerified)
            return Respond(error: $"Security check failed: unauthorized process '{processName}'.");

        try
        {
            var json = Marshal.PtrToStringUTF8(jsonDataPtr)!;
            var request = JsonSerializer.Deserialize(json, NativeJsonContext.Default.ConvertRequest);

            if (string.IsNullOrWhiteSpace(request?.MzmlPath))
                return Respond(error: "MzmlPath is required.");

            var service = new MzmlImspExportService();
            string imspPath = service.ConvertToImspFile(request.MzmlPath, request.OutputPath);

            return Respond(imspPath: imspPath);
        }
        catch (Exception ex)
        {
            return Respond(error: ex.Message);
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

    private static IntPtr Respond(string? imspPath = null, string? error = null)
    {
        var response = new ConvertResponse { ImspPath = imspPath, Error = error };
        return Marshal.StringToCoTaskMemUTF8(
            JsonSerializer.Serialize(response, NativeJsonContext.Default.ConvertResponse));
    }
}
