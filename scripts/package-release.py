#!/usr/bin/env python3
"""Validate and package extension files without backend code, tests, or secrets."""
import argparse
import shutil
import hashlib
import json
from pathlib import Path
import re
import struct
from urllib.parse import urlparse
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "extension"


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def png_size(path):
    data = path.read_bytes()
    require(data[:8] == b"\x89PNG\r\n\x1a\n", f"Not PNG: {path}")
    return struct.unpack(">II", data[16:24])


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--target", choices=["chrome", "firefox", "all"], default="all")
args = parser.parse_args()
manifest = json.loads((EXTENSION / "manifest.json").read_text())
require(manifest["manifest_version"] == 3, "Manifest V3 is required")
require(len(manifest["description"]) <= 132, "Manifest description exceeds 132 characters")
config = (EXTENSION / "config.js").read_text()
backend = re.search(r'export const BACKEND_URL = "([^"]+)";', config)
require(backend, "Missing production backend URL")
backend_url = backend.group(1)
host = urlparse(backend_url)
require(host.scheme == "https" and host.hostname and "YOUR-" not in backend_url and "localhost" not in backend_url,
        "Configure a production HTTPS backend before packaging")
require(f"{backend_url}/*" in manifest["host_permissions"], "Backend host permission is out of sync")
require((EXTENSION / "privacy.html").read_bytes() == (ROOT / "backend/privacy.html").read_bytes(),
        "Packaged and hosted privacy policies differ")
require("contact@deletecookies.dev" in (EXTENSION / "privacy.html").read_text(), "Missing public privacy contact")

resources = [manifest["background"]["service_worker"], manifest["options_page"], manifest["action"]["default_popup"]]
resources += list(manifest["icons"].values()) + list(manifest["action"]["default_icon"].values())
for script in manifest["content_scripts"]:
    resources += script.get("js", []) + script.get("css", [])
for resource in resources:
    path = (EXTENSION / resource).resolve()
    require(path.is_relative_to(EXTENSION.resolve()) and path.is_file(), f"Missing manifest resource: {resource}")
for size in (16, 32, 48, 128):
    require(png_size(EXTENSION / manifest["icons"][str(size)]) == (size, size), f"Wrong {size}px icon dimensions")
require(png_size(ROOT / "store/promo-440x280.png") == (440, 280), "Wrong promotional image dimensions")
screenshots = sorted((ROOT / "store").glob("screenshot-*.png"))
require(screenshots, "At least one actual UI screenshot is required")
for screenshot in screenshots:
    require(png_size(screenshot) in [(1280, 800), (640, 400)], f"Unsupported screenshot size: {screenshot}")
for document in ("LISTING.md", "SUBMISSION.md"):
    require("POLICY_URL_PENDING" not in (ROOT / "store" / document).read_text(), "Resolve the public privacy URL before packaging")

release_dir = ROOT / "releases"
release_dir.mkdir(exist_ok=True)
files = sorted(path for path in EXTENSION.rglob("*") if path.is_file() and path.suffix in {".js", ".html", ".css", ".png", ".json"})
for target in (["chrome", "firefox"] if args.target == "all" else [args.target]):
    target_manifest = json.loads(json.dumps(manifest))
    if target == "firefox":
        target_manifest["background"] = {"scripts": ["background.js"], "type": "module"}
        target_manifest["browser_specific_settings"] = {"gecko": {
            "id": "ai-slop-blocker@deletecookies.dev", "strict_min_version": "142.0",
            "data_collection_permissions": {
                "required": ["none"],
                "optional": ["browsingActivity", "websiteContent", "websiteActivity", "personallyIdentifyingInfo"]
            }
        }}
    filename = f"AI-Slop-Blocker-{manifest['version']}-{target}.zip"
    destination = release_dir / filename
    unpacked = release_dir / target
    require(not unpacked.is_symlink(), "Refusing symlink build directory")
    if unpacked.exists():
        shutil.rmtree(unpacked)
    unpacked.mkdir()
    with ZipFile(destination, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            require(not path.is_symlink(), f"Refusing symlink: {path}")
            relative = path.relative_to(EXTENSION).as_posix()
            data = path.read_bytes()
            if relative == "manifest.json":
                data = (json.dumps(target_manifest, indent=2) + "\n").encode()
            if path.suffix in {".js", ".html", ".json"}:
                text = data.decode()
                require("YOUR-SUBDOMAIN" not in text and "REPLACE_WITH_" not in text, f"Release placeholder in {relative}")
            info = ZipInfo(relative, date_time=(2026, 11, 11, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, data, compresslevel=9)
            output = unpacked / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(data)
    with ZipFile(destination) as archive:
        require(archive.testzip() is None, "Archive CRC failed")
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    (release_dir / f"{filename}.sha256").write_text(f"{digest}  {filename}\n")
    print(json.dumps({"target": target, "package": str(destination), "unpacked": str(unpacked), "files": len(files), "bytes": destination.stat().st_size, "sha256": digest}, indent=2))
