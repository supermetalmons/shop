import contextlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "preflight_assets.py"
spec = importlib.util.spec_from_file_location("preflight_assets", SCRIPT)
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


def png_header(width=2000, height=2800):
    payload = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + struct.pack(">I", len(payload)) + b"IHDR" + payload + b"\0" * 4).ljust(64, b"\0")


def webp_header(kind=b"VP8X", width=1000, height=1400):
    if kind == b"VP8X":
        payload = b"\x10\0\0\0" + (width - 1).to_bytes(3, "little") + (height - 1).to_bytes(3, "little")
    elif kind == b"VP8L":
        payload = b"\x2f" + struct.pack("<I", (width - 1) | ((height - 1) << 14) | (1 << 28))
    else:
        payload = b"\0\0\0\x9d\x01\x2a" + struct.pack("<HH", width, height)
    return (b"RIFF" + struct.pack("<I", 12 + len(payload)) + b"WEBP" + kind + struct.pack("<I", len(payload)) + payload).ljust(64, b"\0")


def response(data, content_type="image/png", status=206, returncode=0, downloaded=64, total=100000):
    headers = f'HTTP/2 {status}\r\ncontent-type: {content_type}\r\ncontent-range: bytes 0-63/{total}\r\ncontent-length: 64\r\netag: "fixture-etag"\r\nlast-modified: Thu, 01 Jan 2026 00:00:00 GMT\r\n\r\n'.encode()
    meta = f"\nCURL-META:{status} {downloaded}\n".encode()
    return subprocess.CompletedProcess([], returncode, stdout=headers + data + meta, stderr=b"fixture network failure" if returncode else b"")


def asset_response(arguments, **kwargs):
    url = arguments[-1]
    if "/fronts/" in url:
        return response(png_header())
    return response(webp_header(), content_type="image/webp")


class PreflightTests(unittest.TestCase):
    def test_png_and_all_webp_headers(self):
        png = preflight.image_header(png_header(), "png")
        self.assertEqual(png, {"dimensions": [2000, 2800], "bitDepth": 8, "colorType": 6})
        for kind, alpha in ((b"VP8X", True), (b"VP8L", True), (b"VP8 ", False)):
            with self.subTest(kind=kind):
                parsed = preflight.image_header(webp_header(kind), "webp")
                self.assertEqual(parsed["dimensions"], [1000, 1400])
                self.assertEqual(parsed["alpha"], alpha)

    def test_malformed_or_truncated_headers_fail_closed(self):
        for extension in ("png", "webp"):
            for data in (b"", b"not an image", b"\0" * 64):
                with self.subTest(extension=extension, data=data):
                    self.assertIn("headerError", preflight.image_header(data, extension))

    def test_fetch_preserves_bounded_request_and_asset_identity(self):
        with patch.object(preflight.subprocess, "run", return_value=response(png_header())) as run:
            result = preflight.fetch(460, "front")
        self.assertTrue(result["passed"])
        self.assertEqual(result["etag"], '"fixture-etag"')
        self.assertEqual(result["totalBytes"], 100000)
        self.assertEqual(result["downloadedBytes"], 64)
        arguments = run.call_args.args[0]
        self.assertEqual(arguments[arguments.index("--range") + 1], "0-63")
        self.assertEqual(arguments[arguments.index("--max-filesize") + 1], "1024")
        self.assertEqual(arguments[arguments.index("--connect-timeout") + 1], "10")
        self.assertEqual(arguments[arguments.index("--max-time") + 1], "25")
        self.assertEqual(arguments[-1], "https://cdn.lil.org/nft/mi_note_cards/fronts/460.png")

    def test_wrong_dimensions_mime_or_ignored_range_are_rejected(self):
        cases = (
            (response(png_header(1000, 1400)), "Unexpected dimensions"),
            (response(png_header(), content_type="text/html"), "Unexpected MIME"),
            (response(png_header(), downloaded=65), "Range ignored"),
        )
        for returned, message in cases:
            with self.subTest(message=message), patch.object(preflight.subprocess, "run", return_value=returned) as run:
                result = preflight.fetch(1, "front")
                self.assertFalse(result["passed"])
                self.assertTrue(any(message in error for error in result["anomalies"]))
                self.assertEqual(run.call_count, 1)

    def test_transient_failures_retry_and_record_history(self):
        replies = [response(b"", status=503, downloaded=0), response(png_header())]
        with patch.object(preflight.subprocess, "run", side_effect=replies) as run, patch.object(preflight.time, "sleep") as sleep:
            result = preflight.fetch(1, "front")
        self.assertTrue(result["passed"])
        self.assertEqual(result["attempts"], 2)
        self.assertEqual(result["retryHistory"][0]["httpStatus"], 503)
        self.assertEqual(run.call_count, 2)
        sleep.assert_called_once_with(1)

    def test_missing_assets_do_not_retry(self):
        with patch.object(preflight.subprocess, "run", return_value=response(b"", status=404, downloaded=0)) as run, patch.object(preflight.time, "sleep") as sleep:
            result = preflight.fetch(1, "front")
        self.assertFalse(result["passed"])
        self.assertEqual(run.call_count, 1)
        sleep.assert_not_called()

    def test_network_retries_are_bounded(self):
        with patch.object(preflight.subprocess, "run", return_value=response(b"", status=0, returncode=28, downloaded=0)) as run, patch.object(preflight.time, "sleep") as sleep:
            result = preflight.fetch(1, "front")
        self.assertFalse(result["passed"])
        self.assertEqual(run.call_count, 3)
        self.assertEqual(result["attempts"], 3)
        self.assertEqual(len(result["retryHistory"]), 2)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2])

    def test_cli_writes_all_4290_asset_checks_to_requested_path(self):
        with tempfile.TemporaryDirectory(prefix="mi-note-preflight-test-") as directory:
            output = Path(directory) / "nested" / "result.json"
            with patch.object(preflight.subprocess, "run", side_effect=asset_response) as run, contextlib.redirect_stdout(io.StringIO()):
                code = preflight.main(["--output", str(output)])
            self.assertEqual(code, 0)
            self.assertEqual(len(run.call_args_list), 4290)
            urls = {call.args[0][-1] for call in run.call_args_list}
            self.assertEqual(len(urls), 4290)
            data = json.loads(output.read_text())
            self.assertTrue(data["complete"])
            self.assertEqual([card["id"] for card in data["cards"]], list(range(1, 1431)))
            self.assertEqual(data["summary"]["assetsPassed"], 4290)
            self.assertEqual(data["summary"]["downloadedHeaderBytesFinalAttempts"], 4290 * 64)
            self.assertEqual(data["anomalies"], [])
            self.assertFalse(output.with_name(output.name + ".tmp").exists())

    def test_cli_returns_failure_when_any_asset_fails(self):
        def missing(arguments, **kwargs):
            if arguments[-1].endswith("/masks/23.webp"):
                return response(b"", content_type="image/webp", status=404, downloaded=0)
            return asset_response(arguments, **kwargs)
        with tempfile.TemporaryDirectory(prefix="mi-note-preflight-test-") as directory:
            output = Path(directory) / "result.json"
            with patch.object(preflight.subprocess, "run", side_effect=missing), contextlib.redirect_stdout(io.StringIO()):
                code = preflight.main(["--output", str(output)])
            data = json.loads(output.read_text())
            self.assertEqual(code, 1)
            self.assertTrue(data["complete"])
            self.assertEqual(data["summary"]["assetsPassed"], 4289)
            self.assertEqual(data["summary"]["anomalyCount"], 1)
            self.assertEqual(data["anomalies"][0]["id"], 23)


if __name__ == "__main__":
    unittest.main(verbosity=2)
