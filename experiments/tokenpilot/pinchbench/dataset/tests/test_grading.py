import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from lib_grading import _judge_via_runtime_compat


class RuntimeJudgeRoutingTests(unittest.TestCase):
    def test_provider_specific_judge_route_overrides_method_route(self):
        env = {
            "PINCHBENCH_JUDGE_KUAIPAO_BASE_URL": "https://judge.example/v1/",
            "PINCHBENCH_JUDGE_KUAIPAO_API_KEY": "judge-key",
            "TOKENPILOT_BASE_URL": "https://method.example/v1",
            "TOKENPILOT_API_KEY": "method-key",
        }
        expected = {"status": "success", "text": "graded"}

        with (
            patch.dict(os.environ, env, clear=True),
            patch(
                "lib_grading._judge_via_openai_compat",
                return_value=expected,
            ) as judge,
        ):
            result = _judge_via_runtime_compat(
                "evaluate this",
                "kuaipao/gpt-5.4-mini",
                30,
            )

        self.assertEqual(result, expected)
        judge.assert_called_once_with(
            "evaluate this",
            "gpt-5.4-mini",
            "https://judge.example/v1/chat/completions",
            "judge-key",
            30,
        )

    def test_unqualified_model_falls_back_to_method_route(self):
        env = {
            "TOKENPILOT_BASE_URL": "https://method.example/v1",
            "TOKENPILOT_API_KEY": "method-key",
        }

        with (
            patch.dict(os.environ, env, clear=True),
            patch(
                "lib_grading._judge_via_openai_compat",
                return_value={"status": "success", "text": "graded"},
            ) as judge,
        ):
            _judge_via_runtime_compat("evaluate this", "gpt-5.4-mini", 30)

        judge.assert_called_once_with(
            "evaluate this",
            "gpt-5.4-mini",
            "https://method.example/v1/chat/completions",
            "method-key",
            30,
        )


if __name__ == "__main__":
    unittest.main()
