#!/bin/bash
set -euo pipefail
source_dir="$(cd "$(dirname "$0")" && pwd)"
app_path="${1:-$source_dir/../../.cache/native-webview/MiNoteCapture.app}"
mkdir -p "$app_path/Contents/MacOS"
cat > "$app_path/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>MiNoteCapture</string>
<key>CFBundleIdentifier</key><string>org.lil.mi-note-native-capture</string>
<key>CFBundleName</key><string>Mi Note Native Capture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
xcrun swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos14.0" "$source_dir/native-webview.swift" -o "$app_path/Contents/MacOS/MiNoteCapture" -framework AppKit -framework WebKit -framework ScreenCaptureKit -framework CoreGraphics -framework CoreVideo -framework ImageIO -framework UniformTypeIdentifiers -framework CryptoKit
codesign --force --sign - "$app_path" >&2
printf '%s\n' "$app_path/Contents/MacOS/MiNoteCapture"
