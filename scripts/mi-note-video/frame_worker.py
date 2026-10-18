import hashlib
import json
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


class FrameOperations:
    def run(self, operation, args):
        if operation == "inspect":
            return frames.inspect_image(args["input"])
        if operation == "prepare":
            return frames.prepare_frame(args["input"], args["output"], args["space"],
                                        args.get("crop"), args.get("inputSpace"), args.get("size"))
        if operation == "compare":
            return compare_images(args["first"], args["second"])
        if operation == "black-exterior":
            return black_exterior(args["input"], args["bounds"], args["size"])
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
