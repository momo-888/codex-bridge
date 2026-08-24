using Microsoft.Win32;
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

namespace CodexBridge.Setup
{
    internal static class Installer
    {
        private const string ProductVersion = "0.6.6";
        private const string PayloadName = "CodexBridge.Payload.zip";

        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            DialogResult answer = MessageBox.Show(
                "Install Codex Bridge for this Windows user?\r\n\r\n" +
                "The app will be installed under Local AppData and start automatically when you sign in.",
                "Codex Bridge Setup",
                MessageBoxButtons.OKCancel,
                MessageBoxIcon.Information);
            if (answer != DialogResult.OK) return;

            try
            {
                string localAppData = Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
                string installRoot = Path.GetFullPath(Path.Combine(localAppData, "CodexBridge", "app"));
                string expectedPrefix = Path.Combine(localAppData, "CodexBridge") + Path.DirectorySeparatorChar;
                if (!installRoot.StartsWith(expectedPrefix, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("The installation directory could not be validated.");

                StopExistingBridge(installRoot);
                StopExistingTray();
                if (Directory.Exists(installRoot)) Directory.Delete(installRoot, true);
                Directory.CreateDirectory(installRoot);
                ExtractPayload(installRoot);
                RunInstallScript(installRoot);
                RegisterUninstaller(installRoot);

                MessageBox.Show(
                    "Codex Bridge is ready.\r\n\r\n" +
                    "Use its tray icon to choose local, Linker / Tailscale, or public relay access.",
                    "Codex Bridge Setup",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
            catch (Exception error)
            {
                MessageBox.Show(error.Message, "Codex Bridge Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Environment.ExitCode = 1;
            }
        }

        private static void ExtractPayload(string installRoot)
        {
            using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadName))
            {
                if (resource == null) throw new InvalidOperationException("The setup payload is missing.");
                using (var archive = new ZipArchive(resource, ZipArchiveMode.Read))
                {
                    string rootPrefix = Path.GetFullPath(installRoot) + Path.DirectorySeparatorChar;
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        string destination = Path.GetFullPath(Path.Combine(installRoot, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                        if (!destination.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase))
                            throw new InvalidOperationException("The setup payload contains an unsafe path.");
                        if (string.IsNullOrEmpty(entry.Name))
                        {
                            Directory.CreateDirectory(destination);
                            continue;
                        }
                        Directory.CreateDirectory(Path.GetDirectoryName(destination));
                        using (Stream input = entry.Open())
                        using (var output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None)) input.CopyTo(output);
                    }
                }
            }
        }

        private static void RunInstallScript(string installRoot)
        {
            string script = Path.Combine(installRoot, "scripts", "install-packaged.ps1");
            var process = Process.Start(new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"),
                Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\"",
                WorkingDirectory = installRoot,
                UseShellExecute = false,
                CreateNoWindow = true
            });
            if (process == null || !process.WaitForExit(30000) || process.ExitCode != 0)
                throw new InvalidOperationException("Codex Bridge was copied, but startup registration failed.");
        }

        private static void RegisterUninstaller(string installRoot)
        {
            string uninstaller = Path.Combine(installRoot, "CodexBridge.Uninstall.exe");
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexBridge"))
            {
                key.SetValue("DisplayName", "Codex Bridge");
                key.SetValue("DisplayVersion", ProductVersion);
                key.SetValue("Publisher", "Codex Bridge contributors");
                key.SetValue("InstallLocation", installRoot);
                key.SetValue("DisplayIcon", Path.Combine(installRoot, "CodexBridge.exe"));
                key.SetValue("UninstallString", "\"" + uninstaller + "\"");
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }

        private static void StopExistingTray()
        {
            string[] names = { "CodexBridge", "CodexBridge.Tray" };
            foreach (string name in names)
            {
                foreach (Process process in Process.GetProcessesByName(name))
                {
                    try { process.Kill(); process.WaitForExit(5000); }
                    catch { }
                }
            }
        }

        private static void StopExistingBridge(string installRoot)
        {
            string script = Path.Combine(installRoot, "scripts", "stop-codex-bridge.ps1");
            if (!File.Exists(script)) return;
            try
            {
                using (Process process = Process.Start(new ProcessStartInfo
                {
                    FileName = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"),
                    Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\"",
                    WorkingDirectory = installRoot,
                    UseShellExecute = false,
                    CreateNoWindow = true
                }))
                {
                    if (process != null) process.WaitForExit(15000);
                }
            }
            catch { }
        }
    }
}
