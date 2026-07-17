Set-Location "D:\AgentChat\src-tauri"

$env:JAVA_HOME = "C:\Program Files\Java\jdk-21.0.10"
$env:ANDROID_HOME = "C:\Users\ZorahM\AppData\Local\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME

$ndkExpected = "$env:ANDROID_HOME\ndk\26.1.10909125"
$ndkReal    = "C:\Users\ZorahM\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\Android\Sdk\ndk\26.1.10909125"

# Tauri 2 ignores env vars — it only looks at $ANDROID_HOME\ndk\<version>
# Create a directory junction so Tauri finds the NDK at the standard path
if (-not (Test-Path "$ndkExpected\source.properties")) {
  if (Test-Path $ndkExpected) {
    Remove-Item -LiteralPath $ndkExpected -Recurse -Force -ErrorAction Stop
  }
  Write-Host "Creating NDK junction: $ndkExpected -> $ndkReal"
  cmd /c "mklink /J ""$ndkExpected"" ""$ndkReal""" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to create junction (try running as Administrator). Falling back to copy..."
    Copy-Item -Recurse -LiteralPath $ndkReal -Destination $ndkExpected
  }
}

$env:NDK_HOME = $ndkExpected
$env:ANDROID_NDK_HOME = $ndkExpected
$env:ANDROID_NDK_ROOT = $ndkExpected
$env:Path = "$env:JAVA_HOME\bin;$env:Path"

Write-Host "`n=== Building APK ==="
cargo tauri android build --apk --debug --target aarch64

Write-Host "`nExit code: $LASTEXITCODE"

Write-Host "`nAPK files:"
Get-ChildItem -Recurse "D:\AgentChat\src-tauri\gen\android" -Filter *.apk -ErrorAction SilentlyContinue |
    Select-Object FullName, @{
        Name = "Size (MB)"
        Expression = { [math]::Round($_.Length / 1MB, 1) }
    } | Format-Table -AutoSize