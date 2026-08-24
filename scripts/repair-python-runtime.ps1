param(
    [Parameter(Mandatory = $true)]
    [string]$PythonRoot
)

$ErrorActionPreference = 'Stop'
$pythonRootPath = [IO.Path]::GetFullPath($PythonRoot).TrimEnd('\')
$sitePackages = [IO.Path]::GetFullPath((Join-Path $pythonRootPath 'Lib\site-packages')).TrimEnd('\')
$pythonExe = Join-Path $pythonRootPath 'python.exe'
if (-not (Test-Path -LiteralPath $pythonExe)) { throw "Embedded Python executable is missing: $pythonExe" }
if (-not (Test-Path -LiteralPath $sitePackages)) { throw "site-packages is missing: $sitePackages" }
$sitePrefix = $sitePackages + '\'

$targets = @(
    (Join-Path $sitePackages 'setuptools'),
    (Join-Path $sitePackages 'pkg_resources'),
    (Join-Path $sitePackages '_distutils_hack')
)
$targets += @(Get-ChildItem -LiteralPath $sitePackages -Force |
    Where-Object { $_.Name -like 'setuptools-*.dist-info' } |
    ForEach-Object FullName)

foreach ($target in $targets | Sort-Object -Unique) {
    $fullTarget = [IO.Path]::GetFullPath($target)
    if (-not $fullTarget.StartsWith($sitePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a dependency outside site-packages: $fullTarget"
    }
    if (Test-Path -LiteralPath $fullTarget) {
        Remove-Item -LiteralPath $fullTarget -Recurse -Force
    }
}

& python -m pip install --disable-pip-version-check --target $sitePackages 'setuptools==84.0.0'
if ($LASTEXITCODE -ne 0) { throw "setuptools installation failed with exit code $LASTEXITCODE" }

$env:PYTHONDONTWRITEBYTECODE = '1'
& $pythonExe -c 'import json, setuptools, torch; print(json.dumps({"setuptools": setuptools.__version__, "torch": torch.__version__}))'
if ($LASTEXITCODE -ne 0) { throw "Embedded Python verification failed with exit code $LASTEXITCODE" }
