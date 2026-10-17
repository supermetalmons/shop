import hashlib
import io
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image

import frames


def compare_images(first, second):
    with Image.open(first) as a, Image.open(second) as b:
        aa, bb = np.asarray(a), np.asarray(b)
        icc = a.info.get("icc_profile")
        same_size = aa.shape == bb.shape
        equal = bool(same_size and np.array_equal(aa, bb))
        same_icc = bool(icc and icc == b.info.get("icc_profile"))
    return {"passed": equal and same_icc, "pixelExact": equal, "iccExact": same_icc,
            "iccSha256": hashlib.sha256(icc).hexdigest() if icc else None}


def black_exterior(input_path, bounds, size):
    with Image.open(input_path) as image:
        image.load()
        a = np.asarray(image)
        left, top, right, bottom = bounds
        icc = image.info.get("icc_profile")
        passed = image.size == (size, size) and image.mode == "RGB" and bool(icc) \
            and all(np.all(part == 0) for part in (a[:top], a[bottom:], a[top:bottom, :left], a[top:bottom, right:]))
    return {"passed": bool(passed), "bounds": bounds, "iccSha256": hashlib.sha256(icc).hexdigest() if icc else None}


class StaticExteriorChecker:
    def __init__(self):
        self.cached = None

    def check(self, reference, paths, bounds, size, expansion_pixels, reference_sha256=None):
        content = Path(reference).read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        key = (str(Path(reference).resolve()), digest, size, tuple(bounds))
        if self.cached is not None and self.cached[0] != key:
            self.cached = None
        if reference_sha256 is not None and digest != reference_sha256:
            self.cached = None
            raise ValueError("Trusted static reference checksum changed.")
        if self.cached is None:
            with Image.open(io.BytesIO(content)) as image:
                image.load()
                profile = image.info.get("icc_profile")
                if image.size != (size, size) or image.mode != "RGB" or not profile:
                    raise ValueError("Invalid static reference")
                reference_pixels = np.asarray(image)
            left, top, right, bottom = bounds
            mask = np.ones((size, size), dtype=bool)
            mask[top:bottom, left:right] = False
            self.cached = (key, mask, reference_pixels[mask], profile)
        _, mask, expected, profile = self.cached
        checks = []
        for path in paths:
            with Image.open(path) as image:
                image.load()
                if image.size != (size, size) or image.mode != "RGB":
                    raise ValueError("Invalid static-check frame: " + path)
                icc_equal = image.info.get("icc_profile") == profile
                pixels = np.asarray(image)[mask]
            different = np.any(expected != pixels, axis=1)
            count = int(different.sum())
            if count:
                delta = np.abs(expected.astype(np.int16) - pixels.astype(np.int16))
                maximum = int(delta.max())
                mean = float(delta.mean())
            else:
                maximum = 0
                mean = 0.0
            checks.append({"path": path, "equal": count == 0, "iccEqual": icc_equal,
                           "differentPixels": count, "maxChannelError": maximum, "meanChannelError": mean,
                           "passed": count == 0 and icc_equal})
        return {"reference": reference, "iccSha256": hashlib.sha256(profile).hexdigest(),
                "excludedCardBounds": bounds, "expansionPixels": expansion_pixels, "checks": checks,
                "passed": all(check["passed"] for check in checks)}


class FrameOperations:
    def __init__(self):
        self.static = StaticExteriorChecker()

    def run(self, operation, args):
        if operation == "inspect":
            return frames.inspect_image(args["input"])
        if operation == "stitch":
            return frames.stitch_frame(args["metadata"], args["output"], args.get("deliverySize"), args.get("deliverySpaces"))
        if operation == "prepare":
            return frames.prepare_frame(args["input"], args["output"], args["space"],
                                        args.get("crop"), args.get("inputSpace"), args.get("size"))
        if operation == "compare":
            return compare_images(args["first"], args["second"])
        if operation == "black-exterior":
            return black_exterior(args["input"], args["bounds"], args["size"])
        if operation == "static-check":
            return self.static.check(args["reference"], json.loads(Path(args["filesPath"]).read_text()),
                                     args["bounds"], args["size"], args["expansionPixels"], args.get("referenceSha256"))
        raise ValueError("Unknown frame worker operation: " + str(operation))


def serve(source, destination):
    operations = FrameOperations()
    limit = 4 * 1024 * 1024
    while line := source.readline(limit + 1):
        request_id = None
        valid_request = False
        try:
            if len(line) > limit or not line.endswith("\n"):
                raise ValueError("Invalid frame worker request length or framing")
            request = json.loads(line)
            if not isinstance(request, dict) or type(request.get("id")) is not int or request["id"] < 1 \
                    or not isinstance(request.get("operation"), str) or not isinstance(request.get("args"), dict):
                raise ValueError("Invalid frame worker request")
            request_id = request["id"]
            valid_request = True
            result = operations.run(request["operation"], request["args"])
            response = {"id": request_id, "result": result}
            encoded = json.dumps(response, allow_nan=False)
        except Exception as error:
            encoded = json.dumps({"id": request_id, "error": {"type": type(error).__name__, "message": str(error)}})
        destination.write(encoded + "\n")
        destination.flush()
        if not valid_request:
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(serve(sys.stdin, sys.stdout))
