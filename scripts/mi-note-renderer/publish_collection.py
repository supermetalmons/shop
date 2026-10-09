import argparse
import datetime
import hashlib
import html
import io
import json
import math
from pathlib import Path
import re
import shutil
import sys
import zipfile

from PIL import Image, ImageCms, ImageDraw, ImageFont


RESERVE_BYTES = 10 * 1024**3
CHUNK_BYTES = 1024**2
PER_PAGE = 20
THUMB_SIZE = (280, 392)
SHEET_SIZE = (1552, 1912)
BACKGROUNDS = ("white", "dark", "checkerboard")
SRGB_BYTES = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load_json(path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(CHUNK_BYTES), b""):
            digest.update(block)
    return digest.hexdigest()


def ensure_space(directory, additional_bytes=0):
    available = shutil.disk_usage(directory).free
    required = RESERVE_BYTES + additional_bytes
    require(available >= required, f"Insufficient free space: {available / 1024**3:.2f} GiB available; {required / 1024**3:.2f} GiB required including 10 GiB reserve")


def write_text(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = content.encode("utf-8")
    ensure_space(path.parent, len(data))
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(data)
    temporary.replace(path)


def write_json(path, value):
    write_text(path, json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def validate_report(report, card_id, icc_hash, icc_bytes):
    require(report.get("id") == card_id, f"#{card_id}: report ID mismatch")
    require((report.get("width"), report.get("height")) == (2000, 2800), f"#{card_id}: report dimensions differ")
    require(report.get("qa", {}).get("passed") is True, f"#{card_id}: reconstruction QA failed")
    require(report["qa"].get("geometryPassed") is True, f"#{card_id}: geometry QA failed")
    require(report["qa"].get("centerNonOpaquePixels") == 0, f"#{card_id}: center is not fully opaque")
    require(report["qa"].get("alphaBounds") == [0, 0, 2000, 2800], f"#{card_id}: artwork bounds differ")
    tolerance = report["qa"].get("recompositionTolerance255")
    require(isinstance(tolerance, (int, float)) and 0 <= tolerance <= 2, f"#{card_id}: invalid recomposition tolerance")
    for matte in ("white", "black"):
        reconstruction = report["qa"].get("recomposition", {}).get(matte, {})
        error = reconstruction.get("maxChannelError255")
        require(isinstance(error, (int, float)) and 0 <= error <= tolerance, f"#{card_id}: {matte} recomposition failed")
        stitching = report.get("stitching", {}).get(matte, {})
        require(stitching.get("passed") is True, f"#{card_id}: {matte} stitching failed")
        overlaps = stitching.get("overlaps", [])
        require(bool(overlaps) and all(item.get("passed") is True for item in overlaps), f"#{card_id}: {matte} overlap QA failed")
    profile = report.get("profile", {})
    require(profile.get("sha256") == icc_hash and profile.get("bytes") == icc_bytes, f"#{card_id}: report ICC mismatch")
    require(profile.get("preservedByteForByte") is True, f"#{card_id}: native ICC preservation unverified")


def validate_thumbnail(path, card_id):
    with Image.open(path) as image:
        require(image.format == "PNG" and image.mode == "RGBA" and image.size == THUMB_SIZE, f"#{card_id}: thumbnail must be 280×392 RGBA PNG")
        profile = image.info.get("icc_profile")
        require(bool(profile), f"#{card_id}: thumbnail missing sRGB ICC")
        description = ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(profile))).strip()
        require("srgb" in description.lower(), f"#{card_id}: thumbnail profile is not sRGB")
        image.verify()


def numeric_png_ids(output):
    paths = [path for path in output.iterdir() if path.suffix.lower() == ".png" and path.stem.isdecimal()]
    require(all(path.name == f"{int(path.stem)}.png" for path in paths), "Numeric PNG names must be canonical positive IDs without leading zeros")
    return {int(path.stem) for path in paths}


def validate_collection(output, cache, expected_count):
    require(output.is_dir(), f"Output directory does not exist: {output}")
    ensure_space(output)
    config = load_json(cache / "run-config.json")
    checkpoint = load_json(cache / "checkpoint.json")
    fingerprint = checkpoint.get("runFingerprint")
    require(isinstance(fingerprint, str) and bool(fingerprint), "Missing run fingerprint")
    require(config.get("runFingerprint", fingerprint) == fingerprint, "Configuration/checkpoint fingerprint mismatch")
    require(checkpoint.get("status") == "captured", "Capture checkpoint must have status 'captured'")
    require(checkpoint.get("startupControlsComplete") is True and checkpoint.get("finalControlsComplete") is True, "Startup and final control gates must be complete")
    expected = set(range(1, expected_count + 1))
    configured_ids = config.get("ids")
    require(isinstance(configured_ids, list) and len(configured_ids) == expected_count and set(configured_ids) == expected, "Configured IDs must be exactly 1 through expected count")
    actual = numeric_png_ids(output)
    require(actual == expected, f"Numeric PNG set mismatch: missing={sorted(expected - actual)}, extra={sorted(actual - expected)}")
    completed = checkpoint.get("completed", {})
    require(set(completed) == {str(value) for value in expected}, "Checkpoint completion set must match every expected card")
    expected_icc = config.get("expectedIccSha256")
    require(isinstance(expected_icc, str) and re.fullmatch(r"[0-9a-f]{64}", expected_icc), "Missing or invalid expected native ICC hash")
    require(isinstance(config.get("sourceHashes"), dict) and bool(config["sourceHashes"]), "Source hashes are required")
    require(isinstance(config.get("settings"), dict), "Capture settings are required")
    entries = []
    for card_id in range(1, expected_count + 1):
        path = output / f"{card_id}.png"
        record = load_json(output / "qa" / f"{card_id}.json")
        completion = completed[str(card_id)]
        require(record.get("id") == card_id and completion.get("id") == card_id, f"#{card_id}: QA/checkpoint ID mismatch")
        require(record.get("runFingerprint") == fingerprint, f"#{card_id}: QA run fingerprint mismatch")
        require(record.get("qaPassed") is True, f"#{card_id}: capture QA did not pass")
        require((record.get("width"), record.get("height"), record.get("mode")) == (2000, 2800, "RGBA"), f"#{card_id}: recorded image format mismatch")
        actual_values = {"fileSha256": file_hash(path), "bytes": path.stat().st_size}
        with Image.open(path) as image:
            require(image.format == "PNG" and image.size == (2000, 2800) and image.mode == "RGBA", f"#{card_id}: actual image must be 2000×2800 RGBA PNG")
            profile = image.info.get("icc_profile")
            require(bool(profile), f"#{card_id}: missing native ICC profile")
            ImageCms.ImageCmsProfile(io.BytesIO(profile))
            actual_values["iccSha256"] = hashlib.sha256(profile).hexdigest()
            require(actual_values["iccSha256"] == expected_icc, f"#{card_id}: native ICC differs from this run")
            image.load()
            actual_values["decodedRgbaSha256"] = hashlib.sha256(image.tobytes()).hexdigest()
        for key, value in actual_values.items():
            require(record.get(key) == value and completion.get(key) == value, f"#{card_id}: {key} differs from QA or checkpoint")
        validate_report(record.get("report", {}), card_id, actual_values["iccSha256"], len(profile))
        validate_thumbnail(output / "thumbnails" / f"{card_id}.png", card_id)
        entries.append({**record, "file": path.name, "thumbnail": f"thumbnails/{card_id}.png", "qaFile": f"qa/{card_id}.json"})
        if card_id % 50 == 0 or card_id == expected_count:
            print(f"Verified {card_id}/{expected_count} full-resolution files, decoded pixels, ICC profiles and QA records", flush=True)
    controls = validate_controls(output, config, checkpoint)
    return config, checkpoint, entries, controls


def validate_controls(output, config, checkpoint):
    control_ids = config.get("controlIds")
    require(isinstance(control_ids, list) and bool(control_ids) and len(set(control_ids)) == len(control_ids), "Distinct configured control IDs are required")
    require(all(str(value) in checkpoint["completed"] for value in control_ids), "Control IDs must belong to the completed collection")
    records = checkpoint.get("controls", [])
    require(isinstance(records, list) and bool(records), "Successful repeatability controls are required")
    labels = set()
    reports = []
    for record in records:
        label = record.get("label")
        require(isinstance(label, str) and label not in labels, "Duplicate or missing control label")
        labels.add(label)
        card_id = record.get("id")
        require(card_id in control_ids and record.get("passed") is True, f"Control {label}: invalid ID or failed comparison")
        require(record.get("runFingerprint") == checkpoint["runFingerprint"], f"Control {label}: run fingerprint mismatch")
        comparison = record.get("comparison", {})
        require(comparison.get("decodedRgbaEqual") is True and comparison.get("iccBytesEqual") is True and comparison.get("differingPixels") == 0 and comparison.get("maxChannelError255") == 0, f"Control {label}: exact decoded RGBA/ICC comparison failed")
        relative = Path(record.get("report", ""))
        require(not relative.is_absolute() and relative.parts and relative.parts[0] == "controls" and ".." not in relative.parts, f"Control {label}: report must be inside output/controls")
        path = output / relative
        require(path.is_file(), f"Control {label}: missing report {relative}")
        report = load_json(path)
        require(report.get("id") == card_id and report.get("label") == label and report.get("qaPassed") is True, f"Control {label}: worker report mismatch")
        require(report.get("runFingerprint") == checkpoint["runFingerprint"], f"Control {label}: report fingerprint mismatch")
        completion = checkpoint["completed"][str(card_id)]
        require(all(report.get(key) == completion[key] for key in ("decodedRgbaSha256", "iccSha256")), f"Control {label}: repeated pixels or ICC differ from the master")
        reports.append({"label": label, "id": card_id, "file": relative.as_posix(), "bytes": path.stat().st_size, "sha256": file_hash(path)})
    startup_id = 460 if len(config["ids"]) >= 460 else control_ids[0]
    startup_label = f"startup-{startup_id}"
    require(startup_label in labels, f"Missing {startup_label} repeatability gate")
    require(next(record["id"] for record in records if record["label"] == startup_label) == startup_id, f"{startup_label} control ID mismatch")
    for card_id in control_ids:
        label = f"end-{card_id}"
        require(any(record["label"] == label and record["id"] == card_id for record in records), f"Missing final exact repeatability control {label}")
    for count in range(100, len(config["ids"]) + 1, 100):
        label = f"after-{count:04d}"
        require(any(record["label"] == label and record["id"] == startup_id for record in records), f"Missing periodic exact repeatability control {label}")
    return {"configuredIds": control_ids, "coverage": "Only the configured control IDs were rendered repeatedly; all collection cards received capture, geometry, overlap and matte reconstruction QA.", "passed": True, "records": records, "reports": reports}


def selected_font(size):
    for candidate in ("/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default(size=size)


def background_region(draw, box, background):
    left, top, right, bottom = box
    if background != "checkerboard":
        draw.rectangle(box, fill=(255, 255, 255) if background == "white" else (24, 25, 29))
        return
    for y in range(top, bottom, 14):
        for x in range(left, right, 14):
            shade = 247 if ((x - left) // 14 + (y - top) // 14) % 2 else 222
            draw.rectangle((x, y, min(x + 13, right - 1), min(y + 13, bottom - 1)), fill=(shade, shade, shade))


def create_contact_sheets(output, entries):
    directory = output / "contact-sheets"
    directory.mkdir(exist_ok=True)
    page_count = math.ceil(len(entries) / PER_PAGE)
    estimated = page_count * len(BACKGROUNDS) * (SHEET_SIZE[0] * SHEET_SIZE[1] * 3 + CHUNK_BYTES)
    ensure_space(directory, estimated)
    pages = []
    for page_index in range(page_count):
        batch = entries[page_index * PER_PAGE:(page_index + 1) * PER_PAGE]
        page = {"page": page_index + 1, "ids": [entry["id"] for entry in batch], "gallery": f"gallery/page-{page_index + 1:03d}.html", "contactSheets": {}}
        for background in BACKGROUNDS:
            sheet = Image.new("RGB", SHEET_SIZE, (244, 243, 239))
            draw = ImageDraw.Draw(sheet)
            draw.text((28, 22), f"MI NOTE CARDS  /  {page_index + 1:02d} OF {page_count:02d}", fill=(30, 32, 31), font=selected_font(27))
            draw.text((28, 62), f"IDs {batch[0]['id']}–{batch[-1]['id']} · {background} background · sRGB review previews", fill=(91, 94, 91), font=selected_font(17))
            for index, entry in enumerate(batch):
                x, y = 28 + (index % 5) * 304, 108 + (index // 5) * 446
                background_region(draw, (x, y, x + 280, y + 392), background)
                with Image.open(output / entry["thumbnail"]) as thumbnail:
                    thumbnail.load()
                    sheet.paste(thumbnail, (x, y), thumbnail)
                draw.text((x, y + 405), f"#{entry['id']}", fill=(30, 32, 31), font=selected_font(19))
                draw.text((x + 84, y + 408), "2000 × 2800 PNG", fill=(91, 94, 91), font=selected_font(14))
            filename = f"{background}-{page_index + 1:03d}.png"
            destination = directory / filename
            ensure_space(directory, SHEET_SIZE[0] * SHEET_SIZE[1] * 3 + CHUNK_BYTES)
            temporary = destination.with_name(destination.name + ".tmp")
            sheet.save(temporary, format="PNG", compress_level=6, icc_profile=SRGB_BYTES)
            sheet.close()
            temporary.replace(destination)
            page["contactSheets"][background] = f"contact-sheets/{filename}"
        pages.append(page)
        print(f"Created contact sheet page {page_index + 1}/{page_count} on three backgrounds", flush=True)
    return pages


CSS = """*{box-sizing:border-box}body{margin:0;background:#f4f3ef;color:#202320;font:16px/1.5 system-ui,-apple-system,sans-serif}main{max-width:1560px;margin:auto;padding:40px 28px}h1{font-size:clamp(30px,4vw,54px);line-height:1.1;letter-spacing:-.045em;margin:10px 0 18px}h2{font-size:24px;margin:40px 0 14px}a{color:inherit;text-underline-offset:4px}small,.muted{color:#60665f}.eyebrow{font-size:12px;font-weight:700;letter-spacing:.15em}nav,.toolbar{display:flex;flex-wrap:wrap;gap:20px;align-items:center;margin:24px 0}button{font:inherit;padding:7px 14px;border:1px solid #adb3aa;border-radius:4px;background:transparent;cursor:pointer}button[aria-pressed=true]{background:#263c2d;color:white;border-color:#263c2d}.page-list{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:0 28px}.page-list li{padding:20px 0;border-top:1px solid #ccd0c7}.page-list strong{display:block;margin-bottom:5px}.sheet-links{display:flex;gap:12px;font-size:13px;margin-top:9px}.ids{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}.ids a{min-width:52px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:26px 24px}.card{margin:0}.card>a{display:block;text-decoration:none}.image{padding:0;display:flex;justify-content:center;background:white;aspect-ratio:5/7}.image img{width:100%;height:auto;object-fit:contain}.cards.dark .image{background:#18191d}.cards.checkerboard .image{background:repeating-conic-gradient(#dedede 0 25%,#f7f7f7 0 50%) 0/28px 28px}.caption{display:flex;justify-content:space-between;font-size:14px;margin-top:10px}.notes{max-width:800px}footer{border-top:1px solid #ccd0c7;padding-top:20px;margin-top:48px;font-size:13px}a:focus-visible,button:focus-visible{outline:3px solid #668b55;outline-offset:4px}@media(min-width:1240px){.cards{grid-template-columns:repeat(5,minmax(0,1fr))}}"""


def document(title, body):
    return f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)}</title><style>{CSS}</style></head><body><main>{body}</main></body></html>\n'


def provenance_reports(output):
    definitions = [
        ("captureConfiguration", "Capture configuration", "capture-config.json"),
        ("assetPreflight", "Source asset preflight", "assets-preflight.json"),
    ]
    for filename in ("capture-session-summary.json", "session-summary.json"):
        if (output / filename).is_file():
            definitions.append(("captureSessionSummary", "Capture session and cleanup", filename))
            break
    for index, path in enumerate(sorted(output.glob("browser-recovery*.json")), 1):
        definitions.append((f"browserRecovery{index}", f"Browser recovery {index}", path.relative_to(output).as_posix()))
    comparison_paths = sorted(output.glob("comparison*/reproduction-report.json"))
    if (output / "historical-comparison.json").is_file():
        comparison_paths.insert(0, output / "historical-comparison.json")
    for index, path in enumerate(comparison_paths, 1):
        definitions.append((f"historicalComparison{index}", f"Historical comparison {index}", path.relative_to(output).as_posix()))
    result = {"reports": [], "historicalComparisons": []}
    for key, label, relative in definitions:
        path = output / relative
        if not path.is_file():
            continue
        result["reports"].append({"id": key, "label": label, "file": relative, "bytes": path.stat().st_size, "sha256": file_hash(path)})
        if key.startswith("historicalComparison"):
            comparison = load_json(path)
            count, matches = comparison.get("count"), comparison.get("passedCount")
            require(isinstance(count, int) and isinstance(matches, int) and 0 <= matches <= count, "Historical comparison has invalid counts")
            result["historicalComparisons"].append({
                "file": relative,
                "count": count,
                "exactMatches": matches,
                "exact": comparison.get("passed") is True and matches == count,
                "acceptanceGate": False,
                "role": "Informational comparison with an earlier capture; separate from exact within-run repeatability controls.",
            })
    return result


def create_gallery(output, entries, pages, controls, provenance=None):
    total = len(entries)
    page_items = []
    for page in pages:
        first, last = page["ids"][0], page["ids"][-1]
        sheet_links = "".join(f'<a href="{path}">{html.escape(background.title())}</a>' for background, path in page["contactSheets"].items())
        page_items.append(f'<li><strong><a href="{page["gallery"]}">Page {page["page"]}: Cards {first}–{last}</a></strong><small>{len(page["ids"])} cards</small><div class="sheet-links">{sheet_links}</div></li>')
        batch = entries[(page["page"] - 1) * PER_PAGE:page["page"] * PER_PAGE]
        cards = []
        for entry in batch:
            card_id = entry["id"]
            cards.append(f'<figure class="card"><a href="../{card_id}.png" aria-label="Open full-resolution card {card_id}"><div class="image"><img src="../thumbnails/{card_id}.png" width="280" height="392" loading="lazy" alt="Mi Note Card {card_id}"></div><figcaption class="caption"><strong>#{card_id}</strong><span>{entry["bytes"] / 1024**2:.1f} MiB PNG</span></figcaption></a></figure>')
        navigation = ['<a href="../index.html">All pages</a>']
        if page["page"] > 1:
            navigation.append(f'<a href="page-{page["page"] - 1:03d}.html">← Previous</a>')
        if page["page"] < len(pages):
            navigation.append(f'<a href="page-{page["page"] + 1:03d}.html">Next →</a>')
        buttons = "".join(f'<button type="button" data-background="{value}" aria-pressed="{str(value == "white").lower()}">{value.title()}</button>' for value in BACKGROUNDS)
        links = " · ".join(f'<a href="../{path}">{name.title()} contact sheet</a>' for name, path in page["contactSheets"].items())
        body = f'<div class="eyebrow">MI NOTE CARDS / PAGE {page["page"]} OF {len(pages)}</div><h1>Cards {first}–{last}</h1><nav>{"".join(navigation)}</nav><div class="toolbar" aria-label="Preview background">{buttons}</div><div class="cards white">{"".join(cards)}</div><footer>{links}<p>Previews use sRGB. Open a card for its full-resolution PNG with the original captured color profile.</p></footer><script>document.querySelectorAll("[data-background]").forEach(button=>button.addEventListener("click",()=>{{document.querySelector(".cards").className="cards "+button.dataset.background;document.querySelectorAll("[data-background]").forEach(item=>item.setAttribute("aria-pressed",String(item===button)));}}));</script>'
        write_text(output / page["gallery"], document(f"Mi Note Cards {first}–{last}", body))
    ids = "".join(f'<a href="{entry["id"]}.png">#{entry["id"]}</a>' for entry in entries)
    control_links = "".join(f'<li><a href="{html.escape(report["file"], quote=True)}">{html.escape(report["label"])} · #{report["id"]}</a></li>' for report in controls["reports"])
    provenance = provenance or {"reports": []}
    provenance_links = "".join(f'<li><a href="{html.escape(report["file"], quote=True)}">{html.escape(report["label"])}</a></li>' for report in provenance["reports"])
    historical_note = ""
    for historical in provenance.get("historicalComparisons", []):
        status = "exact" if historical["exact"] else "not exact"
        historical_note += f'<p class="notes"><a href="{html.escape(historical["file"], quote=True)}">Historical comparison</a>: <strong>{status}</strong>, with {historical["exactMatches"]} of {historical["count"]} exact matches. This comparison is informational and separate from the exact repeat checks within this collection.</p>'
    provenance_section = f'<h2>Capture records</h2>{historical_note}<ul>{provenance_links}</ul>' if provenance_links else ""
    body = f'<div class="eyebrow">MI NOTE CARDS / SAFARI COLLECTION</div><h1>The full collection.<br>{total:,} cards.</h1><p class="muted">2000 × 2800 PNG · Transparent rounded corners · Original captured color profile</p><p class="notes">Browse twenty cards per page and switch preview backgrounds. Open any card to inspect the full-resolution file.</p><nav><a href="gallery/page-001.html">Browse cards →</a><a href="manifest.json">Collection manifest</a><a href="validation.json">Validation report</a></nav><h2>Collection pages</h2><ol class="page-list">{"".join(page_items)}</ol><h2>Full-resolution files</h2><details><summary>Show all {total:,} PNG links</summary><div class="ids">{ids}</div></details><h2>Validation</h2><p class="notes">Every card passed capture and reconstruction QA. Exact repeat rendering was checked for {len(controls["configuredIds"])} control cards, with additional startup and periodic checks.</p><details><summary>View {len(controls["reports"])} repeatability reports</summary><ul>{control_links}</ul></details>{provenance_section}<footer>Previews and contact sheets use sRGB. Full-resolution PNGs retain the native Safari capture profile.</footer>'
    write_text(output / "index.html", document("Mi Note Cards — Safari collection", body))


def publication_files(output):
    return sorted(path for path in output.rglob("*") if path.is_file() and not any(part.startswith(".") for part in path.relative_to(output).parts) and not path.name.endswith(".tmp"))


def create_archive(output, expected_count, known_hashes=None):
    files = publication_files(output)
    total_bytes = sum(path.stat().st_size for path in files)
    archive = output.with_name(output.name + ".zip")
    estimated_bytes = total_bytes + sum(len(path.relative_to(output).as_posix().encode("utf-8")) * 2 + 256 for path in files) + CHUNK_BYTES
    ensure_space(output.parent, estimated_bytes)
    temporary = archive.with_name(archive.name + ".partial")
    require(not temporary.exists(), f"A partial archive already exists: {temporary}; inspect or remove it before retrying")
    try:
        with zipfile.ZipFile(temporary, mode="w", compression=zipfile.ZIP_STORED, allowZip64=True) as bundle:
            for index, path in enumerate(files, 1):
                ensure_space(output.parent, path.stat().st_size + CHUNK_BYTES)
                name = path.relative_to(output).as_posix()
                info = zipfile.ZipInfo.from_file(path, arcname=name)
                info.compress_type = zipfile.ZIP_STORED
                digest = hashlib.sha256()
                with path.open("rb") as source, bundle.open(info, mode="w", force_zip64=True) as destination:
                    for block in iter(lambda: source.read(CHUNK_BYTES), b""):
                        digest.update(block)
                        destination.write(block)
                if known_hashes and name in known_hashes:
                    require(digest.hexdigest() == known_hashes[name], f"{name} changed after publication validation")
                if index % 250 == 0 or index == len(files):
                    print(f"Archived {index}/{len(files)} files", flush=True)
        with zipfile.ZipFile(temporary) as bundle:
            require(bundle.testzip() is None, "Archive CRC validation failed")
            names = bundle.namelist()
            require(len(names) == len(set(names)) == len(files), "Archive has duplicate or missing entries")
            numeric = {int(name[:-4]) for name in names if re.fullmatch(r"[1-9][0-9]*\.png", name)}
            require(numeric == set(range(1, expected_count + 1)), "Archive root numeric PNG set differs from the collection")
        ensure_space(output.parent)
        temporary.replace(archive)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    report = {"file": archive.name, "bytes": archive.stat().st_size, "sha256": file_hash(archive), "entries": len(files), "rootNumericPngCount": expected_count, "crcVerified": True, "zip64Enabled": True}
    write_json(archive.with_name(archive.name + ".json"), report)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description="Validate and publish a complete native Safari Mi Note collection")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--cache", required=True, type=Path)
    parser.add_argument("--expected-count", type=int, default=1430)
    parser.add_argument("--skip-zip", action="store_true", help="Generate validated gallery artifacts without an archive")
    args = parser.parse_args(argv)
    require(args.expected_count > 0, "Expected count must be positive")
    output, cache = args.output.resolve(), args.cache.resolve()
    config, checkpoint, entries, controls = validate_collection(output, cache, args.expected_count)
    pages = create_contact_sheets(output, entries)
    provenance = provenance_reports(output)
    create_gallery(output, entries, pages, controls, provenance)
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    validation = {"completedAt": timestamp, "runFingerprint": checkpoint["runFingerprint"], "count": len(entries), "expectedIds": [1, args.expected_count], "allCaptureQaPassed": True, "allFileHashesVerified": True, "allDecodedRgbaHashesVerified": True, "allNativeIccHashesVerified": True, "allDimensionsAndModesVerified": True, "allThumbnailsVerified": True, "nativeIccSha256": config["expectedIccSha256"], "repeatabilityControlCount": len(controls["records"]), "repeatabilityControlIds": controls["configuredIds"], "repeatabilityControlsPassed": True, "repeatabilityCoverage": controls["coverage"]}
    write_json(output / "validation.json", validation)
    manifest = {"schemaVersion": 1, "createdAt": timestamp, "count": len(entries), "width": 2000, "height": 2800, "mode": "RGBA", "runFingerprint": checkpoint["runFingerprint"], "sourceHashes": config["sourceHashes"], "assetFingerprint": config.get("assetFingerprint"), "settings": config["settings"], "provenance": provenance, "outerMarginPixels": 0, "shadow": "none", "capturePath": "Safari viewport compositor screenshots", "finalColorEncoding": "Original native viewport ICC, preserved byte for byte", "previewColorEncoding": "sRGB", "processing": "Geometry-driven integer tile crop and hard stitch; alpha recovered from white/black mattes. No resizing, pixel shifts, seam blending, contrast changes or color conversion in final PNGs.", "pngBytes": sum(entry["bytes"] for entry in entries), "validation": validation, "repeatability": controls, "contactSheetPages": pages, "gallery": "index.html", "samples": entries, "archivePolicy": {"adjacentFile": output.name + ".zip", "rootContainsNumericPngs": True, "compression": "Stored: PNGs are already compressed", "zip64": True, "excluded": ["Hidden files and directories", "Temporary .tmp files"], "requested": not args.skip_zip}}
    write_json(output / "manifest.json", manifest)
    archive = None if args.skip_zip else create_archive(output, args.expected_count, {entry["file"]: entry["fileSha256"] for entry in entries})
    ensure_space(output)
    result = {"count": len(entries), "contactSheetPagesPerBackground": len(pages), "contactSheets": len(pages) * len(BACKGROUNDS), "gallery": str(output / "index.html"), "manifest": str(output / "manifest.json"), "archive": archive}
    print(json.dumps(result, indent=2), flush=True)
    return result


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
