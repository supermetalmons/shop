import sys

sys.dont_write_bytecode = True

import argparse
import hashlib
import json
from pathlib import Path
import re

import image_core as finalizer




class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)



def check(metadata_path, expected_icc):
    if not re.fullmatch(r"[0-9a-fA-F]{64}", expected_icc):
        raise ValueError("Expected ICC must be a SHA-256 hexadecimal digest")
    document = json.loads(metadata_path.read_text())
    card_id = document.get("id")
    matte = document.get("matte")
    if isinstance(card_id, bool) or not isinstance(card_id, int) or not 1 <= card_id <= 1430:
        raise ValueError("Metadata card ID must be an integer between 1 and 1430")
    if matte not in ("white", "black"):
        raise ValueError("Metadata must describe one white or black matte")
    if (document.get("width"), document.get("height")) != (2000, 2800):
        raise ValueError("Metadata must describe native 2000×2800 artwork")
    records = document.get("tiles")
    if not isinstance(records, list) or len(records) != 2:
        raise ValueError("Metadata must contain exactly two completed viewport tiles")
    tiles = []
    profile = None
    try:
        for record in records:
            tile, profile = finalizer.load_tile(
                record, metadata_path.parent, 2000, 2800, str(card_id), matte, profile,
            )
            tiles.append(tile)
            actual_icc = hashlib.sha256(profile).hexdigest()
            if actual_icc != expected_icc.lower():
                raise ValueError(f"Native ICC profile differs: expected {expected_icc.lower()}, got {actual_icc}")
        tiles.sort(key=lambda tile: tile["origin"])
        if tiles[0]["origin"] > 0 or tiles[-1]["origin"] + tiles[-1]["image"].height < 2800:
            raise ValueError("Viewport tiles do not cover the full card")
        diagnostic = finalizer.overlap_diagnostic(tiles[0], tiles[1], 2800, 64)
        return {
            "id": card_id,
            "matte": matte,
            "width": 2000,
            "height": 2800,
            "iccSha256": actual_icc,
            "tiles": [tile["metadata"] for tile in tiles],
            "topCaptureGutterPixels": -tiles[0]["origin"],
            "bottomCaptureGutterPixels": tiles[-1]["origin"] + tiles[-1]["image"].height - 2800,
            **diagnostic,
            "metrics": diagnostic["seamBandMetrics"],
        }
    finally:
        for tile in tiles:
            tile["image"].close()


def main():
    parser = Parser(description="Validate one Safari viewport matte pair without writing files")
    parser.add_argument("--metadata", required=True, type=Path)
    parser.add_argument("--expected-icc", required=True)
    try:
        args = parser.parse_args()
        result = check(args.metadata.resolve(), args.expected_icc)
        print(json.dumps(result, allow_nan=False))
        return 0 if result["passed"] else 2
    except Exception as error:
        print(json.dumps({"passed": False, "error": str(error), "type": type(error).__name__}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
