using System.Text.Json;
using System.Text.Json.Serialization;
using Readers;

public sealed class ConvertRequest
{
    public string? MzmlPath { get; set; }
    public string? OutputPath { get; set; }
}

public sealed class ConvertResponse
{
    public string? ImspPath { get; set; }
    public string? Error { get; set; }
}

[JsonSerializable(typeof(ConvertRequest))]
[JsonSerializable(typeof(ConvertResponse))]
internal partial class WorkerJsonContext : JsonSerializerContext
{
}

internal static class Program
{
    private static int Main(string[] args)
    {
        var response = new ConvertResponse();

        try
        {
            if (args.Length != 1)
            {
                response.Error = "Expected exactly one JSON request argument.";
            }
            else
            {
                var request = JsonSerializer.Deserialize(args[0], WorkerJsonContext.Default.ConvertRequest);
                if (string.IsNullOrWhiteSpace(request?.MzmlPath))
                {
                    response.Error = "MzmlPath is required.";
                }
                else
                {
                    var service = new MzmlImspExportService();
                    response.ImspPath = service.ConvertToImspFile(request.MzmlPath, request.OutputPath);
                }
            }
        }
        catch (Exception ex)
        {
            response.Error = ex.ToString();
        }

        Console.Out.Write(JsonSerializer.Serialize(response, WorkerJsonContext.Default.ConvertResponse));
        return 0;
    }
}
