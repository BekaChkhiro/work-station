# Windows Authenticode Signing

This document covers how to configure Windows Authenticode code signing for the Work Station app.

## Overview

Windows builds are signed with an **Authenticode** certificate so Windows Defender SmartScreen trusts the installer and executable. Unsigned executables often show a "Windows protected your PC" warning that discourages users from installing.

## Required GitHub Secrets

Add these secrets to your repository (`Settings → Secrets and variables → Actions`):

| Secret | Description |
|--------|-------------|
| `WINDOWS_CERTIFICATE` | Base64-encoded `.pfx` code signing certificate |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password used when exporting the `.pfx` |

## Certificate Options

### OV (Organization Validated) Certificate

Suitable for most applications. Provides basic SmartScreen reputation that builds over time as more users install the app.

1. Purchase from a trusted CA (DigiCert, Sectigo, Certum, etc.)
2. Complete the organization validation process
3. Export the certificate + private key as a `.pfx` file
4. Base64-encode it for the GitHub secret:
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.pfx")) | Set-Clipboard
   ```
   Or on macOS/Linux:
   ```bash
   base64 -i certificate.pfx | pbcopy
   ```

### EV (Extended Validation) Certificate — Preferred

Provides **immediate SmartScreen reputation** and is strongly recommended for public distribution. EV certificates eliminate the reputation-building period that OV certs require.

EV certificates are typically stored on a hardware token (HSM) and cannot be exported as `.pfx`. For EV signing in CI:

1. Use a cloud HSM signing service (e.g., DigiCert KeyLocker, Azure Key Vault, SSL.com eSigner)
2. Or use a self-hosted runner with the HSM physically attached
3. Configure a custom `signCommand` in `tauri.conf.json`:
   ```json
   {
     "bundle": {
       "windows": {
         "timestampUrl": "http://timestamp.digicert.com",
         "signCommand": "signtool.exe sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /sha1 <THUMBPRINT> %1"
       }
     }
   }
   ```

## Configuration

### `tauri.conf.json`

The Windows bundle section configures the timestamp server:

```json
{
  "bundle": {
    "windows": {
      "timestampUrl": "http://timestamp.digicert.com"
    }
  }
}
```

This ensures signatures remain valid after the certificate expires.

### GitHub Actions

The `build.yml` workflow passes the signing secrets to the Tauri action:

```yaml
env:
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  WINDOWS_CERTIFICATE: ${{ secrets.WINDOWS_CERTIFICATE }}
  WINDOWS_CERTIFICATE_PASSWORD: ${{ secrets.WINDOWS_CERTIFICATE_PASSWORD }}
```

The [Tauri GitHub Action](https://github.com/tauri-apps/tauri-action) automatically signs the `.exe` and `.msi` when these environment variables are present.

## How It Works

1. During the build, Tauri bundles the app into an NSIS `.exe` installer and/or an MSI `.msi`
2. The Tauri action detects `WINDOWS_CERTIFICATE` and invokes `signtool.exe` to sign both the installer and the main executable
3. The timestamp server adds a countersignature so the signature remains valid even after the certificate expires
4. Both the NSIS `.exe` and MSI `.msi` are signed

## Verifying the Signature

After downloading a signed build, you can verify the signature on Windows:

```powershell
# Check the MSI
signtool verify /pa "work-station_0.1.0_x64_en-US.msi"

# Check the executable inside the installer
# (extract or install, then check the installed .exe)
signtool verify /pa "C:\Program Files\work-station\work-station.exe"
```

Or inspect the digital signature tab in the file properties dialog.

## Local Development

For local builds, you can sign manually after bundling:

```powershell
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /f certificate.pfx /p <password> "target\release\bundle\nsis\work-station_0.1.0_x64-setup.exe"
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /f certificate.pfx /p <password> "target\release\bundle\msi\work-station_0.1.0_x64_en-US.msi"
```

Or set the environment variables before running `pnpm tauri build`:

```powershell
$env:WINDOWS_CERTIFICATE = [Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.pfx"))
$env:WINDOWS_CERTIFICATE_PASSWORD = "your-password"
pnpm tauri build
```
