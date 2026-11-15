# Optional local Browser Driver for Luculent Desktop on Windows

The Browser Driver can be packaged with Luculent Desktop on Windows. The build machine supplies Node and npm. The installed relay uses its bundled Node executable and locked production dependency.

## Build the optional installer

Use a Windows build machine with the normal desktop build prerequisites. Build for the same architecture as the Node executable used to stage the relay. Use the official Node.js distribution and its matching `LICENSE` file.

From the repository root:

```powershell
npm ci --omit=dev --prefix tools/browser-driver
node tools/browser-driver/scripts/package-local-relay.mjs tools/browser-driver app/src-tauri/target/browser-driver <path-to-node-license>
npm ci --prefix app
Push-Location app
try { npm run tauri -- build --config src-tauri/tauri.browser-driver.windows.json }
finally { Pop-Location }
```

Stage to an empty folder for each build. `lbd.cmd` runs the bundled relay with the current profile's key storage and access settings. Installers built without the optional configuration use the standard resource list.

## Acceptance before shipping

On a clean Windows machine, verify the package layout and the bundled runtime's signature. Run `lbd.cmd start`, pair the intended Chrome extension, and verify grant, denial and revocation through a real local MCP client. The unpacked extension included for testing uses the source manifest's ID. The Chrome Web Store listing has its own ID, which must be verified before enabling it by default. Confirm the local relay only listens on loopback and test with Node and npm absent from the machine.
