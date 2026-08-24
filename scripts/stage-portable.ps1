param(
    [Parameter(Mandatory = $true)]
    [string]$WorkspaceRoot,
    [string]$CodexSource = '',
    [string]$Destination = ''
)

$ErrorActionPreference = 'Stop'
$workspace = [System.IO.Path]::GetFullPath($WorkspaceRoot)
$project = Join-Path $workspace 'work\jinjing-desktop'
if ([string]::IsNullOrWhiteSpace($Destination)) {
    $destination = Join-Path $workspace 'outputs\Jinjing-Portable-Windows-x64'
} else {
    $destination = [System.IO.Path]::GetFullPath($Destination)
}
$appSource = Join-Path $project 'release\win-unpacked'
$pythonSource = Join-Path $workspace 'work\python-embed'
$skillSource = Join-Path $workspace 'outputs\jinjing'
$codexSource = $CodexSource
if ([string]::IsNullOrWhiteSpace($codexSource)) {
    $codexCommand = Get-Command codex.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $codexCommand) {
        throw 'Codex executable was not found. Pass -CodexSource with an explicit codex.exe path.'
    }
    $codexSource = $codexCommand.Source
}
$codexSource = [System.IO.Path]::GetFullPath($codexSource)
$codexRepo = Join-Path $workspace 'work\codex-main-inspect\codex-main'

foreach ($required in @($appSource, $pythonSource, $skillSource, $codexSource)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Required release input is missing: $required"
    }
}
if (Test-Path -LiteralPath $destination) {
    throw "Destination already exists; refusing to overwrite: $destination"
}

function Copy-Tree([string]$Source, [string]$Destination) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    & robocopy.exe $Source $Destination /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -gt 7) {
        throw "Robocopy failed with exit code ${LASTEXITCODE}: $Source"
    }
}

Copy-Tree $appSource $destination
$pythonDestination = Join-Path $destination 'resources\python'
Copy-Tree $pythonSource $pythonDestination
Copy-Tree $skillSource (Join-Path $destination 'resources\jinjing')
New-Item -ItemType Directory -Force -Path (Join-Path $destination 'resources\codex') | Out-Null
Copy-Item -LiteralPath $codexSource -Destination (Join-Path $destination 'resources\codex\codex.exe')

function Assert-StagedPath([string]$Path) {
    $fullDestination = [System.IO.Path]::GetFullPath($destination).TrimEnd('\') + '\'
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if (-not $fullPath.StartsWith($fullDestination, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the staged payload: $fullPath"
    }
}

$sitePackages = Join-Path $pythonDestination 'Lib\site-packages'
$licensesDestination = Join-Path $destination 'LICENSES\Python'
New-Item -ItemType Directory -Force -Path $licensesDestination | Out-Null
$torchThirdParty = Join-Path $sitePackages 'torch-2.13.0.dist-info\licenses\third_party'
if (Test-Path -LiteralPath $torchThirdParty) {
    $torchLicenseArchive = Join-Path $licensesDestination 'torch-third-party-licenses.zip'
    Compress-Archive -LiteralPath $torchThirdParty -DestinationPath $torchLicenseArchive -CompressionLevel Optimal
    Assert-StagedPath $torchThirdParty
    Remove-Item -LiteralPath $torchThirdParty -Recurse -Force
}

$buildOnlyOrStaleItems = @(
    (Join-Path $sitePackages 'pip'),
    (Join-Path $sitePackages 'torch-2.11.0+cpu.dist-info')
)
$buildOnlyOrStaleItems += @(Get-ChildItem -LiteralPath $sitePackages -Force | Where-Object { $_.Name -like 'pip-*.dist-info' } | ForEach-Object FullName)
foreach ($buildOnlyOrStaleItem in $buildOnlyOrStaleItems | Sort-Object -Unique) {
    if (Test-Path -LiteralPath $buildOnlyOrStaleItem) {
        Assert-StagedPath $buildOnlyOrStaleItem
        Remove-Item -LiteralPath $buildOnlyOrStaleItem -Recurse -Force
    }
}

$cacheDirectories = @(Get-ChildItem -LiteralPath $pythonDestination -Recurse -Directory -Force | Where-Object { $_.Name -eq '__pycache__' } | Sort-Object FullName -Descending)
foreach ($cacheDirectory in $cacheDirectories) {
    Assert-StagedPath $cacheDirectory.FullName
    Remove-Item -LiteralPath $cacheDirectory.FullName -Recurse -Force
}

foreach ($wrongArchitecture in @('cli-32.exe', 'gui-32.exe', 'cli-arm64.exe', 'gui-arm64.exe')) {
    $wrongArchitecturePath = Join-Path $sitePackages "setuptools\$wrongArchitecture"
    if (Test-Path -LiteralPath $wrongArchitecturePath) {
        Assert-StagedPath $wrongArchitecturePath
        Remove-Item -LiteralPath $wrongArchitecturePath -Force
    }
}

Copy-Item -LiteralPath (Join-Path $project 'resources\README.txt') -Destination (Join-Path $destination 'README.txt')
Copy-Item -LiteralPath (Join-Path $project 'resources\THIRD-PARTY-NOTICES.txt') -Destination (Join-Path $destination 'THIRD-PARTY-NOTICES.txt')
New-Item -ItemType Directory -Force -Path (Join-Path $destination 'LICENSES\Codex') | Out-Null
Copy-Item -LiteralPath (Join-Path $codexRepo 'LICENSE') -Destination (Join-Path $destination 'LICENSES\Codex\LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $codexRepo 'NOTICE') -Destination (Join-Path $destination 'LICENSES\Codex\NOTICE.txt')

$database = Join-Path $destination 'resources\jinjing\data\jinjing_evidence.db'
$model = Join-Path $destination 'resources\jinjing\models\bge-m3\pytorch_model.bin'
$manifest = [ordered]@{
    product = 'Jinjing'
    version = '0.1.0'
    platform = 'windows-x64'
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    codexVersion = '0.147.0'
    pythonVersion = '3.11.9-embed-amd64'
    corpus = [ordered]@{
        papers = 76139
        abstracts = 72402
        embeddings = 76139
        databaseBytes = (Get-Item -LiteralPath $database).Length
    }
    sha256 = [ordered]@{
        executable = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $destination 'Jinjing.exe')).Hash.ToLowerInvariant()
        codex = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $destination 'resources\codex\codex.exe')).Hash.ToLowerInvariant()
        database = (Get-FileHash -Algorithm SHA256 -LiteralPath $database).Hash.ToLowerInvariant()
        model = (Get-FileHash -Algorithm SHA256 -LiteralPath $model).Hash.ToLowerInvariant()
    }
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $destination 'MANIFEST.json') -Encoding utf8

$measure = Get-ChildItem -LiteralPath $destination -Recurse -File | Measure-Object Length -Sum
[pscustomobject]@{
    Destination = $destination
    Files = $measure.Count
    Bytes = $measure.Sum
    GiB = [math]::Round($measure.Sum / 1GB, 3)
}
