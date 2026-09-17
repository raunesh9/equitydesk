"""Build the small macOS WebKit wrapper using Apple's installed tools."""
import json
import plistlib
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent
CONTENTS = ROOT / 'EquityDesk.app/Contents'
MACOS, RESOURCES = CONTENTS / 'MacOS', CONTENTS / 'Resources'
MACOS.mkdir(parents=True, exist_ok=True)
RESOURCES.mkdir(exist_ok=True)
CACHE = ROOT / 'work/swift-cache'
CACHE.mkdir(parents=True, exist_ok=True)
subprocess.run(['/usr/bin/swiftc', '-swift-version', '5', '-module-cache-path', str(CACHE),
                '-O', str(ROOT / 'native/EquityDesk.swift'), '-o', str(MACOS / 'EquityDesk'), '-framework', 'Cocoa', '-framework', 'WebKit'], check=True)
iconset = ROOT / 'work/EquityDesk.iconset'
iconset.mkdir(exist_ok=True)
subprocess.run(['/usr/bin/swift', '-module-cache-path', str(CACHE), str(ROOT / 'native/make_icon.swift'), str(iconset)], check=True)
subprocess.run(['/usr/bin/iconutil', '-c', 'icns', str(iconset), '-o', str(RESOURCES / 'EquityDesk.icns')], check=True)
(RESOURCES / 'workspace.txt').write_text(str(ROOT))
with (CONTENTS / 'Info.plist').open('wb') as stream:
    plistlib.dump({'CFBundleName': 'EquityDesk', 'CFBundleDisplayName': 'EquityDesk', 'CFBundleExecutable': 'EquityDesk',
        'CFBundleIdentifier': 'local.equitydesk.app', 'CFBundlePackageType': 'APPL', 'CFBundleVersion': '2',
        'CFBundleShortVersionString': '0.2', 'CFBundleIconFile': 'EquityDesk.icns', 'NSHighResolutionCapable': True,
        'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True}, 'LSMinimumSystemVersion': '13.0'}, stream)
subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', str(CONTENTS.parent)], check=True)
print('Built ' + str(CONTENTS.parent))
