import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PipelineTests(unittest.TestCase):
    def test_stream_copy_verified(self):
        report = json.loads((ROOT / "build/extraction-report.json").read_text())
        self.assertEqual(len(report["files"]), 4)
        self.assertTrue(all(item["verifiedStreamCopy"] for item in report["files"]))

    def test_alignment_is_monotonic_and_covered(self):
        data = json.loads((ROOT / "docs/data/alignment.json").read_text())
        anchors = data["anchors"]
        self.assertTrue(data["validation"]["monotonic"])
        self.assertGreater(data["validation"]["coverage5016"], 0.95)
        self.assertGreater(data["validation"]["coverage5017"], 0.95)
        self.assertGreaterEqual(len(data["markers"]), 6)
        self.assertLessEqual(len(data["markers"]), 15)
        for first, second in zip(anchors, anchors[1:]):
            self.assertLess(first["t5016"], second["t5016"])
            self.assertLess(first["t5017"], second["t5017"])

    def test_only_encrypted_audio_is_published(self):
        forbidden = {".mov", ".m4a", ".wav"}
        self.assertFalse([path for path in (ROOT / "docs").rglob("*") if path.suffix.lower() in forbidden])
        encrypted = list((ROOT / "docs/assets").glob("*.enc"))
        self.assertEqual(len(encrypted), 4)
        self.assertTrue(all(path.stat().st_size < 100_000_000 for path in encrypted))

    def test_static_site_has_no_third_party_urls(self):
        for relative in ["docs/index.html", "docs/styles.css", "docs/app.js"]:
            text = (ROOT / relative).read_text()
            self.assertNotIn("http://", text)
            self.assertNotIn("https://", text)
        html = (ROOT / "docs/index.html").read_text()
        self.assertIn("Content-Security-Policy", html)
        self.assertIn("noindex,nofollow,noarchive", html)
        self.assertIn("media-src 'self' blob:", html)


if __name__ == "__main__":
    unittest.main()
