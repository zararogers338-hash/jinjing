param(
    [Parameter(Mandatory = $true)]
    [string]$RootDirectory,

    [Parameter(Mandatory = $true)]
    [string]$ManifestPath,

    [string]$CompareDirectory,

    [string[]]$AllowedCompareOnlyPaths = @(),

    [string[]]$AllowedRootOnlyPaths = @()
)

$ErrorActionPreference = "Stop"

function Resolve-ExistingDirectory([string]$PathValue) {
    $item = Get-Item -LiteralPath $PathValue
    if (-not $item.PSIsContainer) {
        throw "Not a directory: $PathValue"
    }
    return $item.FullName.TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Get-TreeRecords([string]$Root) {
    $rootPrefix = $Root + [IO.Path]::DirectorySeparatorChar
    return @(Get-ChildItem -LiteralPath $Root -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($rootPrefix.Length).Replace("\", "/")
        if ($relative.StartsWith("../") -or [IO.Path]::IsPathRooted($relative)) {
            throw "Unsafe relative path: $relative"
        }
        [pscustomobject]@{
            Path = $relative
            Bytes = [int64]$_.Length
            SHA256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    } | Sort-Object Path)
}

$root = Resolve-ExistingDirectory $RootDirectory
$manifestFullPath = [IO.Path]::GetFullPath($ManifestPath)
if (Test-Path -LiteralPath $manifestFullPath) {
    throw "Manifest already exists: $manifestFullPath"
}
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($manifestFullPath)) | Out-Null

$records = @(Get-TreeRecords $root | Where-Object { $_.Path -notin $AllowedRootOnlyPaths })
$writer = [IO.StreamWriter]::new($manifestFullPath, $false, [Text.UTF8Encoding]::new($false))
try {
    foreach ($record in $records) {
        $writer.WriteLine("{0}`t{1}`t{2}", $record.SHA256, $record.Bytes, $record.Path)
    }
}
finally {
    $writer.Dispose()
}

$longest = $records | Sort-Object { $_.Path.Length } -Descending | Select-Object -First 1
$result = [ordered]@{
    root = $root
    files = $records.Count
    bytes = [int64](($records | Measure-Object Bytes -Sum).Sum)
    longestRelativePath = $longest.Path
    longestRelativePathLength = $longest.Path.Length
    manifest = $manifestFullPath
    manifestSHA256 = (Get-FileHash -LiteralPath $manifestFullPath -Algorithm SHA256).Hash.ToLowerInvariant()
    compare = $null
}

if ($CompareDirectory) {
    $compareRoot = Resolve-ExistingDirectory $CompareDirectory
    $compareRecords = @(Get-TreeRecords $compareRoot | Where-Object { $_.Path -notin $AllowedCompareOnlyPaths })
    $differences = @(Compare-Object -ReferenceObject $records -DifferenceObject $compareRecords -Property Path, Bytes, SHA256)
    $result.compare = [ordered]@{
        root = $compareRoot
        files = $compareRecords.Count
        bytes = [int64](($compareRecords | Measure-Object Bytes -Sum).Sum)
        differences = $differences.Count
    }
    if ($differences.Count -gt 0) {
        $sample = $differences | Select-Object -First 10 | ConvertTo-Json -Compress
        throw "Release tree differs from installed tree ($($differences.Count) differences): $sample"
    }
}

$result | ConvertTo-Json -Depth 5
