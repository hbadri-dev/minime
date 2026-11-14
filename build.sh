#!/bin/bash
# Builds build/MiniMe.app (universal: Apple silicon + Intel, ad-hoc signed).
#   ./build.sh            build
#   ./build.sh --install  build, copy to ~/Applications and launch
#   ./build.sh --zip      build and create build/MiniMe-<version>.zip
set -euo pipefail
cd "$(dirname "$0")"

./tools/fetch_mediapipe.sh

APP=build/MiniMe.app
VERSION=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" Info.plist)
FRAMEWORKS=(-framework Cocoa -framework WebKit -framework AVFoundation -framework Vision -framework ServiceManagement -framework Network)

rm -rf "$APP" build/obj
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" build/obj
for ARCH in arm64 x86_64; do
  swiftc -O -swift-version 5 -target "$ARCH-apple-macos13.0" "${FRAMEWORKS[@]}" Sources/*.swift -o "build/obj/MiniMe-$ARCH"
done
lipo -create build/obj/MiniMe-arm64 build/obj/MiniMe-x86_64 -output "$APP/Contents/MacOS/MiniMe"
cp Info.plist "$APP/Contents/Info.plist"
rsync -a --exclude '.DS_Store' web/ "$APP/Contents/Resources/web/"
cp art/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cp LICENSE THIRD_PARTY_NOTICES.md "$APP/Contents/Resources/"
codesign --force --sign - "$APP"
echo "Built $APP ($VERSION, $(lipo -archs "$APP/Contents/MacOS/MiniMe"))"

case "${1:-}" in
  --install)
    pkill -x MiniMe 2>/dev/null || true
    rm -rf ~/Applications/MiniMe.app
    mkdir -p ~/Applications
    cp -R "$APP" ~/Applications/MiniMe.app
    open ~/Applications/MiniMe.app
    echo "Installed to ~/Applications/MiniMe.app"
    ;;
  --zip)
    ditto -c -k --sequesterRsrc --keepParent "$APP" "build/MiniMe-$VERSION.zip"
    echo "Created build/MiniMe-$VERSION.zip"
    ;;
esac
