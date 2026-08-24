param(
    [Parameter(Mandatory = $true)]
    [string]$PortableDirectory,
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [Parameter(Mandatory = $true)]
    [string]$SevenZipRoot
)

$ErrorActionPreference = 'Stop'
$portable = [IO.Path]::GetFullPath($PortableDirectory).TrimEnd('\')
$output = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
$sevenZip = [IO.Path]::GetFullPath($SevenZipRoot).TrimEnd('\')
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$sevenZa = Join-Path $sevenZip 'extra\x64\7za.exe'
$sevenZaDll = Join-Path $sevenZip 'extra\x64\7za.dll'
$sfx = Join-Path $sevenZip 'sdk\bin\7zSD.sfx'

foreach ($required in @($portable, $csc, $sevenZa, $sevenZaDll, $sfx, (Join-Path $project 'installer\Setup.cs'))) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing installer input: $required" }
}
if ([IO.Path]::GetFileName($portable) -cne 'app') {
    throw "Installer payload directory must be named exactly 'app': $portable"
}
$longestRelativePath = Get-ChildItem -LiteralPath $portable -Recurse -File -Force |
    ForEach-Object { $_.FullName.Substring($portable.Length + 1) } |
    Sort-Object Length -Descending |
    Select-Object -First 1
if ($longestRelativePath.Length -gt 180) {
    throw "Installer payload contains an unsafe SFX path ($($longestRelativePath.Length) characters): $longestRelativePath"
}

New-Item -ItemType Directory -Force -Path $output | Out-Null
$helper = Join-Path $output 'setup.exe'
$archive = Join-Path $output 'Jinjing-Setup.payload.7z'
$config = Join-Path $output 'Jinjing-Setup.config.txt'
$installer = Join-Path $output 'Jinjing-Setup.exe'

foreach ($target in @($helper, $archive, $config, $installer)) {
    if (Test-Path -LiteralPath $target) { throw "Refusing to overwrite existing release artifact: $target" }
}

& $csc /nologo /target:winexe /platform:x64 /optimize+ /out:$helper /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:Microsoft.CSharp.dll (Join-Path $project 'installer\Setup.cs')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $helper)) { throw 'C# installer helper compilation failed' }

Push-Location $output
try {
    & $sevenZa a -t7z $archive $helper -mx=0 -mmt=on
    if ($LASTEXITCODE -ne 0) { throw 'Failed to add setup helper to payload' }
    & $sevenZa a -t7z $archive $portable -m0=lzma2 -mx=6 -mmt=on -ms=256m -myv=2200
    if ($LASTEXITCODE -ne 0) { throw 'Failed to add portable release to payload' }
}
finally {
    Pop-Location
}

$configText = @'
;!@Install@!UTF-8!
Title="晋京 Jinjing 安装程序"
BeginPrompt="安装晋京运动医学循证助手？完整离线版本约占用 4.7 GiB。"
RunProgram="setup.exe"
;!@InstallEnd@!
'@
[IO.File]::WriteAllText($config, $configText, (New-Object Text.UTF8Encoding($false)))

$outputStream = [IO.File]::Open($installer, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    foreach ($part in @($sfx, $config, $archive)) {
        $input = [IO.File]::OpenRead($part)
        try { $input.CopyTo($outputStream, 4MB) } finally { $input.Dispose() }
    }
}
finally {
    $outputStream.Dispose()
}

if ((Get-Item -LiteralPath $installer).Length -ge 4GB) {
    throw "Installer exceeds the Windows executable size boundary: $installer"
}

[pscustomobject]@{
    Installer = $installer
    Bytes = (Get-Item -LiteralPath $installer).Length
    Sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash.ToLowerInvariant()
}
