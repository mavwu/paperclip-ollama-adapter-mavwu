using System;
using System.Diagnostics;
using System.IO;

public static class NpmShim
{
    private const string NodeExe = @"C:\Program Files\nodejs\node.exe";
    private const string NpmCli = @"C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js";

    public static int Main(string[] args)
    {
        if (!File.Exists(NodeExe))
        {
            Console.Error.WriteLine("node.exe was not found at " + NodeExe);
            return 1;
        }

        if (!File.Exists(NpmCli))
        {
            Console.Error.WriteLine("npm-cli.js was not found at " + NpmCli);
            return 1;
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = NodeExe,
            Arguments = Quote(NpmCli) + " " + JoinQuoted(args),
            UseShellExecute = false,
            RedirectStandardInput = false,
            RedirectStandardOutput = false,
            RedirectStandardError = false,
            WorkingDirectory = Environment.CurrentDirectory
        };

        using (var process = Process.Start(startInfo))
        {
            if (process == null)
            {
                Console.Error.WriteLine("Failed to start npm.");
                return 1;
            }

            process.WaitForExit();
            return process.ExitCode;
        }
    }

    private static string JoinQuoted(string[] args)
    {
        var quoted = new string[args.Length];
        for (var i = 0; i < args.Length; i++)
        {
            quoted[i] = Quote(args[i]);
        }

        return string.Join(" ", quoted);
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}
