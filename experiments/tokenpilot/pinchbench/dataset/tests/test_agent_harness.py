import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from lib_agent import (
    _backfill_transcript_cache_usage_from_audit,
    _has_only_failed_assistant_turns,
    _is_transient_provider_error,
)


def assistant_message(**message):
    return {"type": "message", "message": {"role": "assistant", **message}}


class CacheUsageBackfillTests(unittest.TestCase):
    def test_backfills_canonical_and_legacy_state_directories(self):
        for state_dirname in ("tokenpilot-state", "tokenpilot-plugin-state"):
            with self.subTest(state_dirname=state_dirname), tempfile.TemporaryDirectory() as tmp:
                audit_dir = Path(tmp) / state_dirname / "cache-audit-sessions"
                audit_dir.mkdir(parents=True)
                (audit_dir / "session-1.jsonl").write_text(
                    json.dumps({"cachedInputTokens": 2048}) + "\n",
                    encoding="utf-8",
                )
                transcript = [assistant_message(usage={})]

                with patch.dict(os.environ, {"OPENCLAW_STATE_DIR": tmp}):
                    _backfill_transcript_cache_usage_from_audit(
                        transcript,
                        ["session-1"],
                    )

                usage = transcript[0]["message"]["usage"]
                self.assertEqual(usage["cacheRead"], 2048)
                self.assertEqual(usage["input_tokens_details"]["cached_tokens"], 2048)
                self.assertEqual(
                    usage["providerRaw"]["prompt_tokens_details"]["cached_tokens"],
                    2048,
                )

    def test_preserves_existing_nonzero_cache_usage(self):
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = Path(tmp) / "tokenpilot-state" / "cache-audit-sessions"
            audit_dir.mkdir(parents=True)
            (audit_dir / "session-1.jsonl").write_text(
                json.dumps({"cachedInputTokens": 2048}) + "\n",
                encoding="utf-8",
            )
            transcript = [assistant_message(usage={"cacheRead": 512})]

            with patch.dict(os.environ, {"OPENCLAW_STATE_DIR": tmp}):
                _backfill_transcript_cache_usage_from_audit(transcript, ["session-1"])

            self.assertEqual(transcript[0]["message"]["usage"]["cacheRead"], 512)


class ProviderFailureTests(unittest.TestCase):
    def test_detects_transient_provider_failure(self):
        transient, reason = _is_transient_provider_error(
            [assistant_message(stopReason="error", errorMessage="503 Service Unavailable")]
        )

        self.assertTrue(transient)
        self.assertIn("503", reason)

    def test_does_not_retry_nontransient_provider_failure(self):
        transient, reason = _is_transient_provider_error(
            [assistant_message(stopReason="error", errorMessage="401 invalid API key")]
        )

        self.assertFalse(transient)
        self.assertEqual(reason, "")

    def test_marks_error_only_assistant_transcript_as_failed(self):
        failed, reason = _has_only_failed_assistant_turns(
            [assistant_message(stopReason="error", errorMessage="upstream unavailable")]
        )

        self.assertTrue(failed)
        self.assertEqual(reason, "upstream unavailable")

    def test_accepts_transcript_with_successful_assistant_content(self):
        failed, reason = _has_only_failed_assistant_turns(
            [
                assistant_message(stopReason="error", errorMessage="temporary timeout"),
                assistant_message(stopReason="stop", content=[{"text": "completed"}]),
            ]
        )

        self.assertFalse(failed)
        self.assertEqual(reason, "")


if __name__ == "__main__":
    unittest.main()
