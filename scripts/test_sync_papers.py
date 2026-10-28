import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from sync_papers import MAX_BYTES, allowed_url, fulfil, pdf_path

REQUEST_ID = "12345678-abcd-1234-abcd-123456789abc"
PDF = b"%PDF-1.4\nTest PDF\n%%EOF"


class PaperImportsTest(unittest.TestCase):
    def request(self, root, paper_id="2406.07550"):
        path = root / f".paper-imports/requests/{REQUEST_ID}.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"version": 1, "id": paper_id, "requestId": REQUEST_ID}))

    def test_only_public_arxiv_ids_and_redirects(self):
        self.assertEqual(pdf_path("hep-th/9901001v2"), "public/documents/studio/arxiv/hep-th_9901001v2.pdf")
        for value in ["../../etc/passwd", "2406.07550?token=x", "https://example.com", None]:
            with self.assertRaises(ValueError):
                pdf_path(value)
        for url in ["http://arxiv.org/pdf/x", "https://127.0.0.1/", "https://arxiv.org.evil.test/", "https://user:password@arxiv.org/x", "https://arxiv.org:444/x"]:
            self.assertFalse(allowed_url(url))
        self.assertTrue(allowed_url("https://export.arxiv.org/pdf/2406.07550"))

    def test_writes_verified_result_and_reuses_cached_download(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.request(root)
            fulfil(root, lambda paper_id: PDF)
            result_path = root / f".paper-imports/results/{REQUEST_ID}.json"
            result = json.loads(result_path.read_text())
            self.assertEqual(result["sha256"], hashlib.sha256(PDF).hexdigest())
            self.assertEqual(result["blobSha"], hashlib.sha1(f"blob {len(PDF)}\0".encode() + PDF).hexdigest())
            self.assertEqual((root / f"public{result['path']}").read_bytes(), PDF)
            result_path.unlink()
            def unexpected_fetch(_):
                self.fail("Cached PDF must not be downloaded again")
            fulfil(root, unexpected_fetch)
            self.assertNotIn("error", json.loads(result_path.read_text()))

    def test_rejects_invalid_and_large_responses_without_pdf_files(self):
        for data in [b"<html>Error page</html>", b"%PDF-" + b"x" * MAX_BYTES]:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                self.request(root)
                fulfil(root, lambda _: data)
                result = json.loads((root / f".paper-imports/results/{REQUEST_ID}.json").read_text())
                self.assertIn("error", result)
                self.assertFalse((root / pdf_path("2406.07550")).exists())

    def test_accepts_pdf_larger_than_old_twenty_mb_limit(self):
        data = PDF + b" " * (25 * 1024 * 1024)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.request(root)
            fulfil(root, lambda _: data)
            result = json.loads((root / f".paper-imports/results/{REQUEST_ID}.json").read_text())
            self.assertNotIn("error", result)
            self.assertEqual(result["size"], len(data))
            self.assertEqual(result["sha256"], hashlib.sha256(data).hexdigest())

    def test_invalid_requests_never_reach_the_downloader(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.request(root, "../../private")
            def unexpected_fetch(_):
                self.fail("Invalid identifiers must not reach the downloader")
            fulfil(root, unexpected_fetch)
            self.assertIn("error", json.loads((root / f".paper-imports/results/{REQUEST_ID}.json").read_text()))


if __name__ == "__main__":
    unittest.main()
