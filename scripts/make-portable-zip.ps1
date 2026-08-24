param(
    [Parameter(Mandatory = $true)]
    [string]$SourceDirectory,
    [Parameter(Mandatory = $true)]
    [string]$DestinationZip
)

$ErrorActionPreference = 'Stop'
$source = [System.IO.Path]::GetFullPath($SourceDirectory).TrimEnd('\')
$destination = [System.IO.Path]::GetFullPath($DestinationZip)
if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "Source directory does not exist: $source"
}
if (Test-Path -LiteralPath $destination) {
    throw "Refusing to overwrite existing archive: $destination"
}

Add-Type -AssemblyName System.IO.Compression
$rootName = [System.IO.Path]::GetFileName($source)
$files = Get-ChildItem -LiteralPath $source -Recurse -File
$archiveStream = [System.IO.File]::Open($destination, [System.IO.FileMode]::CreateNew)
$archive = New-Object System.IO.Compression.ZipArchive($archiveStream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
try {
    $index = 0
    foreach ($file in $files) {
        $relative = [System.IO.Path]::GetRelativePath($source, $file.FullName).Replace('\', '/')
        $entryName = "$rootName/$relative"
        $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::NoCompression)
        $entry.LastWriteTime = $file.LastWriteTime
        $inputStream = [System.IO.File]::OpenRead($file.FullName)
        $outputStream = $entry.Open()
        try {
            $inputStream.CopyTo($outputStream, 4MB)
        }
        finally {
            $outputStream.Dispose()
            $inputStream.Dispose()
        }
        $index++
        if (($index % 2000) -eq 0) {
            Write-Output "Archived $index / $($files.Count) files"
        }
    }
}
finally {
    $archive.Dispose()
    $archiveStream.Dispose()
}

Get-Item -LiteralPath $destination | Select-Object FullName, Length, LastWriteTime
