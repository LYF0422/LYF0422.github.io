"""Fulfil Studio requests for public arXiv PDFs; no arbitrary URLs or credentials."""

import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SETTINGS = json.loads((Path(__file__).resolve().parents[1] / "src/data/paper-settings.json").read_text())
MAX_BYTES = SETTINGS["maxPdfMegabytes"] * 1024 * 1024
ID_PATTERN = re.compile(r"(?:\d{4}\.\d{4,5}|[a-z-]+/\d{7})(?:v\d+)?", re.I)
UUID_PATTERN = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")
ALLOWED_HOSTS = {"arxiv.org", "export.arxiv.org"}


def pdf_path(paper_id):
    if not isinstance(paper_id, str) or not ID_PATTERN.fullmatch(paper_id):
        raise ValueError("Invalid arXiv identifier")
    return f"public/documents/studio/arxiv/{paper_id.replace('/', '_')}.pdf"


def allowed_url(url):
    parts = urllib.parse.urlsplit(url)
    return (
        parts.scheme == "https"
        and parts.hostname in ALLOWED_HOSTS
        and parts.port in (None, 443)
        and not parts.username
        and not parts.password
    )


class ArxivRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed_url(newurl):
            raise ValueError("arXiv redirected outside its download service")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(paper_id):
    pdf_path(paper_id)
    opener = urllib.request.build_opener(ArxivRedirect)
    request = urllib.request.Request(
        f"https://arxiv.org/pdf/{paper_id}",
        headers={"User-Agent": "Yifan-Paper-Studio/1.0 (+https://lyf0422.github.io/)"},
    )
    deadline = time.monotonic() + SETTINGS["transferTimeoutSeconds"]
    with opener.open(request, timeout=30) as response:
        if not allowed_url(response.url):
            raise ValueError("Unexpected download location")
        size = int(response.headers.get("Content-Length", "0"))
        if size > MAX_BYTES:
            raise ValueError(f"PDF exceeds {SETTINGS['maxPdfMegabytes']} MB")
        chunks, size = [], 0
        while True:
            if time.monotonic() > deadline:
                raise TimeoutError("arXiv download timed out")
            chunk = response.read(64 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_BYTES:
                raise ValueError(f"PDF exceeds {SETTINGS['maxPdfMegabytes']} MB")
            chunks.append(chunk)
    data = b"".join(chunks)
    if b"%PDF-" not in data[:1024]:
        raise ValueError("arXiv did not return a PDF")
    return data


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def fulfil(root, fetch=download):
    root = Path(root)
    index_file = root / "public/documents/studio/arxiv/index.json"
    index = json.loads(index_file.read_text()) if index_file.exists() else {"version": 1, "papers": {}}
    if index.get("version") != 1 or not isinstance(index.get("papers"), dict):
        raise ValueError("Invalid paper cache index")
    for request_file in sorted((root / ".paper-imports/requests").glob("*.json")):
        request_id = request_file.stem
        result_file = root / f".paper-imports/results/{request_id}.json"
        if not UUID_PATTERN.fullmatch(request_id) or result_file.exists():
            continue
        if request_file.is_symlink() or request_file.stat().st_size > 2048:
            continue
        paper_id = ""
        try:
            task = json.loads(request_file.read_text())
            paper_id = task.get("id")
            target_path = pdf_path(paper_id)
            if task.get("version") != 1 or task.get("requestId") != request_id:
                raise ValueError("Invalid request")
            target = root / target_path
            cached = index["papers"].get(paper_id, {})
            data = target.read_bytes() if target.is_file() and not target.is_symlink() else b""
            if not data or len(data) > MAX_BYTES or hashlib.sha256(data).hexdigest() != cached.get("sha256"):
                data = fetch(paper_id)
                if len(data) > MAX_BYTES or b"%PDF-" not in data[:1024]:
                    raise ValueError("Invalid PDF download")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            record = {
                "path": target_path.removeprefix("public"),
                "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
            index["papers"][paper_id] = record
            write_json(index_file, index)
            blob_sha = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
            write_json(result_file, {"requestId": request_id, "id": paper_id, **record, "blobSha": blob_sha})
            print(f"Fetched arXiv {paper_id}: {len(data)} bytes")
        except Exception as error:
            # Never expose environment, credentials, response bodies, or full request URLs.
            if isinstance(error, urllib.error.HTTPError):
                message = f"arXiv returned HTTP {error.code}"
            elif isinstance(error, (TimeoutError, urllib.error.URLError)):
                message = "Cannot download from arXiv at present"
            else:
                message = str(error)[:160]
            write_json(result_file, {"requestId": request_id, "id": paper_id, "error": message})
            print(f"Import {request_id} failed: {message}")


if __name__ == "__main__":
    fulfil(Path.cwd())
