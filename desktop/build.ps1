param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [string]$Dotnet = '${MOLLY_ROOT}\qq-whale\out\dotnet-sdk\dotnet.exe'
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Dotnet -PathType Leaf)) {
    throw "未找到 .NET SDK：$Dotnet"
}

& $Dotnet build (Join-Path $PSScriptRoot 'MollyDesktop.csproj') --configuration $Configuration
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "构建产物：$(Join-Path $PSScriptRoot "bin\$Configuration\net8.0-windows")"
