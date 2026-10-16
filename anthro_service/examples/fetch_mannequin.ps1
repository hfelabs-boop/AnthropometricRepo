# PowerShell 5.1 / 7: the dimensions of a boundary manikin as a CSV you can import into a spreadsheet or a tool's parameter table.
#   .\fetch_mannequin.ps1 -Country "United States" -Role Army -Sex M -Percentile 95 -Out army_p95.csv
# NOT TESTED in this repository's CI (no PowerShell there): it only uses Invoke-RestMethod.
param(
    [string]$Country = "United States",
    [string]$Role = "Army",
    [string]$Sex = "M",
    [double]$Percentile = 50,
    [string]$Measures = "",
    [string]$Base = "http://127.0.0.1:8000",
    [string]$ApiKey = "",
    [string]$Out = ""
)
$inv = [Globalization.CultureInfo]::InvariantCulture
$query = "country=$([uri]::EscapeDataString($Country))&role=$([uri]::EscapeDataString($Role))&sex=$([uri]::EscapeDataString($Sex))&percentile=$($Percentile.ToString($inv))"
if ($Measures) { $query += "&measures=$([uri]::EscapeDataString($Measures))" }
$headers = @{}
if ($ApiKey) { $headers["X-API-Key"] = $ApiKey }
$r = Invoke-RestMethod -Uri "$Base/v1/mannequin?$query" -Headers $headers
$rows = $r.dimensions | Select-Object key, name, unit, value, basis, reliability, n
if ($Out) { $rows | Export-Csv -Path $Out -NoTypeInformation -Encoding UTF8; "Wrote $($rows.Count) dimensions to $Out" }
else { $rows | Format-Table -AutoSize }
Write-Host $r.notes[0]
