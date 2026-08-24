using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace JinjingInstaller
{
    internal static class Program
    {
        private const string PayloadFolder = "app";
        private const long ReserveBytes = 512L * 1024L * 1024L;

        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                Options options = Options.Parse(args);
                string source = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, PayloadFolder));
                if (options.Silent)
                {
                    Install(source, options.Target, options.CreateDesktopShortcut, options.Launch, null);
                    return 0;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new InstallerForm(source, options.Target));
                return InstallerForm.ExitCode;
            }
            catch (Exception error)
            {
                WriteLog("FATAL " + error);
                if (!HasArgument(args, "--silent"))
                    MessageBox.Show(error.Message, "晋京安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        private static bool HasArgument(string[] args, string name)
        {
            foreach (string value in args)
                if (string.Equals(value, name, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        internal static string DefaultTarget
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Jinjing"); }
        }

        internal static void Install(string source, string target, bool desktopShortcut, bool launch, Action<int, string> progress)
        {
            ValidateSource(source);
            target = ValidateTarget(source, target);
            if (Directory.Exists(target) && Directory.GetFileSystemEntries(target).Length > 0)
                throw new IOException("安装目录必须为空：" + target);
            string[] files = Directory.GetFiles(source, "*", SearchOption.AllDirectories);
            long totalBytes = 0;
            foreach (string file in files) totalBytes += new FileInfo(file).Length;
            EnsureDiskSpace(target, totalBytes + ReserveBytes);
            Directory.CreateDirectory(target);

            long copied = 0;
            foreach (string file in files)
            {
                string relative = RelativePath(source, file);
                string destination = Path.GetFullPath(Path.Combine(target, relative));
                EnsureWithin(target, destination);
                string parent = Path.GetDirectoryName(destination);
                if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                CopyFile(file, destination, delegate(long count)
                {
                    copied += count;
                    if (progress != null)
                    {
                        int percent = totalBytes == 0 ? 100 : (int)Math.Min(99, copied * 100L / totalBytes);
                        progress(percent, relative);
                    }
                });
            }

            VerifyCriticalFiles(target);
            CreateStartMenuShortcut(target);
            if (desktopShortcut) CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "晋京 Jinjing.lnk"), Path.Combine(target, "Jinjing.exe"), target);
            File.WriteAllText(Path.Combine(target, "INSTALL-LOCATION.txt"), target + Environment.NewLine, new UTF8Encoding(false));
            if (progress != null) progress(100, "完成");
            WriteLog("Installed to " + target);
            if (launch) Process.Start(new ProcessStartInfo(Path.Combine(target, "Jinjing.exe")) { WorkingDirectory = target, UseShellExecute = true });
        }

        private static void ValidateSource(string source)
        {
            if (!Directory.Exists(source)) throw new InvalidOperationException("安装载荷缺失：" + source);
            string[] required = {
                "Jinjing.exe",
                "MANIFEST.json",
                Path.Combine("resources", "app.asar"),
                Path.Combine("resources", "codex", "codex.exe"),
                Path.Combine("resources", "python", "python.exe"),
                Path.Combine("resources", "jinjing", "SKILL.md"),
                Path.Combine("resources", "jinjing", "data", "jinjing_evidence.db"),
                Path.Combine("resources", "jinjing", "models", "bge-m3", "pytorch_model.bin")
            };
            foreach (string relative in required)
                if (!File.Exists(Path.Combine(source, relative))) throw new InvalidOperationException("安装载荷不完整：" + relative);
        }

        private static string ValidateTarget(string source, string target)
        {
            if (string.IsNullOrWhiteSpace(target)) throw new ArgumentException("安装目录不能为空");
            string full = Path.GetFullPath(Environment.ExpandEnvironmentVariables(target)).TrimEnd(Path.DirectorySeparatorChar);
            string root = Path.GetPathRoot(full).TrimEnd(Path.DirectorySeparatorChar);
            if (string.Equals(full, root, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("不能安装到磁盘根目录");
            if (IsWithin(source, full) || IsWithin(full, source)) throw new ArgumentException("安装目录不能与临时安装载荷互相包含");
            return full;
        }

        private static void EnsureDiskSpace(string target, long required)
        {
            string root = Path.GetPathRoot(target);
            DriveInfo drive = new DriveInfo(root);
            if (drive.AvailableFreeSpace < required)
                throw new IOException(string.Format(CultureInfo.InvariantCulture, "磁盘空间不足：至少需要 {0:F1} GiB 可用空间", required / 1073741824.0));
        }

        private static string RelativePath(string root, string file)
        {
            string normalizedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string normalizedFile = Path.GetFullPath(file);
            if (!normalizedFile.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase)) throw new IOException("载荷路径越界");
            return normalizedFile.Substring(normalizedRoot.Length);
        }

        private static bool IsWithin(string parent, string child)
        {
            string normalizedParent = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string normalizedChild = Path.GetFullPath(child).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            return normalizedChild.StartsWith(normalizedParent, StringComparison.OrdinalIgnoreCase);
        }

        private static void EnsureWithin(string parent, string child)
        {
            if (!IsWithin(parent, child) && !string.Equals(Path.GetFullPath(parent), Path.GetFullPath(child), StringComparison.OrdinalIgnoreCase))
                throw new IOException("目标路径越界：" + child);
        }

        private static void CopyFile(string source, string destination, Action<long> onBytes)
        {
            using (FileStream input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read, 4 * 1024 * 1024, FileOptions.SequentialScan))
            using (FileStream output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None, 4 * 1024 * 1024, FileOptions.SequentialScan))
            {
                byte[] buffer = new byte[4 * 1024 * 1024];
                int read;
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    output.Write(buffer, 0, read);
                    if (onBytes != null) onBytes(read);
                }
                output.Flush(true);
            }
            File.SetLastWriteTimeUtc(destination, File.GetLastWriteTimeUtc(source));
        }

        private static void VerifyCriticalFiles(string target)
        {
            string manifestPath = Path.Combine(target, "MANIFEST.json");
            string manifest = File.ReadAllText(manifestPath, Encoding.UTF8);
            Dictionary<string, string> expected = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (Match match in Regex.Matches(manifest, "\"(executable|codex|database|model)\"\\s*:\\s*\"([0-9a-fA-F]{64})\""))
                expected[match.Groups[1].Value] = match.Groups[2].Value.ToLowerInvariant();
            Dictionary<string, string> paths = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
                { "executable", Path.Combine(target, "Jinjing.exe") },
                { "codex", Path.Combine(target, "resources", "codex", "codex.exe") },
                { "database", Path.Combine(target, "resources", "jinjing", "data", "jinjing_evidence.db") },
                { "model", Path.Combine(target, "resources", "jinjing", "models", "bge-m3", "pytorch_model.bin") }
            };
            foreach (KeyValuePair<string, string> item in paths)
            {
                if (!expected.ContainsKey(item.Key)) throw new InvalidDataException("清单缺少哈希：" + item.Key);
                string actual = Sha256(item.Value);
                if (!string.Equals(actual, expected[item.Key], StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("安装后哈希校验失败：" + item.Key);
            }
        }

        private static string Sha256(string file)
        {
            using (SHA256 hash = SHA256.Create())
            using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read, 4 * 1024 * 1024, FileOptions.SequentialScan))
            {
                byte[] bytes = hash.ComputeHash(stream);
                StringBuilder text = new StringBuilder(bytes.Length * 2);
                foreach (byte value in bytes) text.Append(value.ToString("x2", CultureInfo.InvariantCulture));
                return text.ToString();
            }
        }

        private static void CreateStartMenuShortcut(string target)
        {
            string folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "晋京 Jinjing");
            Directory.CreateDirectory(folder);
            CreateShortcut(Path.Combine(folder, "晋京 Jinjing.lnk"), Path.Combine(target, "Jinjing.exe"), target);
        }

        private static void CreateShortcut(string shortcutPath, string executable, string workingDirectory)
        {
            Type type = Type.GetTypeFromProgID("WScript.Shell");
            if (type == null) return;
            dynamic shell = Activator.CreateInstance(type);
            dynamic shortcut = shell.CreateShortcut(shortcutPath);
            shortcut.TargetPath = executable;
            shortcut.WorkingDirectory = workingDirectory;
            shortcut.Description = "晋京 Jinjing — 运动医学循证助手";
            shortcut.IconLocation = executable + ",0";
            shortcut.Save();
        }

        internal static void WriteLog(string message)
        {
            try
            {
                string file = Path.Combine(Path.GetTempPath(), "Jinjing-Setup.log");
                File.AppendAllText(file, DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) + " " + message + Environment.NewLine, new UTF8Encoding(false));
            }
            catch { }
        }

        internal sealed class Options
        {
            internal bool Silent;
            internal bool CreateDesktopShortcut = true;
            internal bool Launch = true;
            internal string Target = DefaultTarget;

            internal static Options Parse(string[] args)
            {
                Options result = new Options();
                for (int index = 0; index < args.Length; index++)
                {
                    string value = args[index];
                    if (string.Equals(value, "--silent", StringComparison.OrdinalIgnoreCase)) result.Silent = true;
                    else if (string.Equals(value, "--no-launch", StringComparison.OrdinalIgnoreCase)) result.Launch = false;
                    else if (string.Equals(value, "--no-desktop-shortcut", StringComparison.OrdinalIgnoreCase)) result.CreateDesktopShortcut = false;
                    else if (string.Equals(value, "--target", StringComparison.OrdinalIgnoreCase))
                    {
                        if (++index >= args.Length) throw new ArgumentException("--target 缺少路径");
                        result.Target = args[index];
                    }
                    else if (!string.Equals(value, "-y", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("未知安装参数：" + value);
                }
                return result;
            }
        }

        internal sealed class InstallerForm : Form
        {
            internal static int ExitCode = 1;
            private readonly string source;
            private readonly TextBox pathBox;
            private readonly CheckBox desktopBox;
            private readonly CheckBox launchBox;
            private readonly ProgressBar progressBar;
            private readonly Label statusLabel;
            private readonly Button installButton;
            private readonly Button browseButton;

            internal InstallerForm(string sourcePath, string defaultTarget)
            {
                source = sourcePath;
                Text = "晋京 Jinjing 安装程序";
                ClientSize = new Size(640, 285);
                FormBorderStyle = FormBorderStyle.FixedDialog;
                MaximizeBox = false;
                StartPosition = FormStartPosition.CenterScreen;
                Font = new Font("Microsoft YaHei UI", 9F);

                Label title = new Label { Left = 28, Top = 24, Width = 580, Height = 32, Text = "晋京 Jinjing 0.1.0", Font = new Font("Microsoft YaHei UI", 16F, FontStyle.Bold) };
                Label description = new Label { Left = 30, Top = 64, Width = 570, Height = 38, Text = "运动医学循证助手 · 完整离线文库与 BGE-M3\r\n安装后约占用 4.5 GiB。" };
                Label pathLabel = new Label { Left = 30, Top = 118, Width = 100, Height = 24, Text = "安装位置" };
                pathBox = new TextBox { Left = 30, Top = 143, Width = 490, Height = 27, Text = defaultTarget };
                browseButton = new Button { Left = 530, Top = 141, Width = 78, Height = 29, Text = "浏览…" };
                desktopBox = new CheckBox { Left = 30, Top = 180, Width = 180, Height = 24, Text = "创建桌面快捷方式", Checked = true };
                launchBox = new CheckBox { Left = 230, Top = 180, Width = 180, Height = 24, Text = "安装后启动晋京", Checked = true };
                progressBar = new ProgressBar { Left = 30, Top = 215, Width = 460, Height = 22, Minimum = 0, Maximum = 100 };
                installButton = new Button { Left = 500, Top = 210, Width = 108, Height = 36, Text = "安装" };
                statusLabel = new Label { Left = 30, Top = 247, Width = 575, Height = 25, Text = "准备就绪" };
                Controls.AddRange(new Control[] { title, description, pathLabel, pathBox, browseButton, desktopBox, launchBox, progressBar, installButton, statusLabel });

                browseButton.Click += Browse;
                installButton.Click += StartInstall;
            }

            private void Browse(object sender, EventArgs args)
            {
                using (FolderBrowserDialog dialog = new FolderBrowserDialog())
                {
                    dialog.Description = "选择晋京安装目录";
                    dialog.SelectedPath = pathBox.Text;
                    if (dialog.ShowDialog(this) == DialogResult.OK) pathBox.Text = dialog.SelectedPath;
                }
            }

            private void StartInstall(object sender, EventArgs args)
            {
                installButton.Enabled = false;
                browseButton.Enabled = false;
                pathBox.Enabled = false;
                statusLabel.Text = "正在复制文件…";
                string target = pathBox.Text;
                bool desktopShortcut = desktopBox.Checked;
                Thread worker = new Thread(delegate()
                {
                    try
                    {
                        Install(source, target, desktopShortcut, false, delegate(int percent, string file)
                        {
                            BeginInvoke((MethodInvoker)delegate { progressBar.Value = percent; statusLabel.Text = percent < 100 ? "正在安装 / " + file : "安装完成"; });
                        });
                        ExitCode = 0;
                        BeginInvoke((MethodInvoker)delegate
                        {
                            installButton.Text = "完成";
                            installButton.Enabled = true;
                            installButton.Click -= StartInstall;
                            installButton.Click += delegate { if (launchBox.Checked) Process.Start(new ProcessStartInfo(Path.Combine(target, "Jinjing.exe")) { WorkingDirectory = target, UseShellExecute = true }); Close(); };
                            MessageBox.Show(this, "晋京已经安装并完成关键文件哈希校验。", "安装完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
                        });
                    }
                    catch (Exception error)
                    {
                        WriteLog("INSTALL ERROR " + error);
                        BeginInvoke((MethodInvoker)delegate
                        {
                            installButton.Enabled = true;
                            browseButton.Enabled = true;
                            pathBox.Enabled = true;
                            statusLabel.Text = "安装失败";
                            MessageBox.Show(this, error.Message, "安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        });
                    }
                });
                worker.IsBackground = true;
                worker.Start();
            }
        }
    }
}
