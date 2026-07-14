import sys
import unittest
from pathlib import Path
from types import SimpleNamespace


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from benchmark import _select_tasks


class SelectTasksTests(unittest.TestCase):
    def test_explicit_suite_preserves_order_and_skips_unknown_ids(self):
        tasks = [
            SimpleNamespace(task_id="task-a", grading_type="automated"),
            SimpleNamespace(task_id="task-b", grading_type="automated"),
            SimpleNamespace(task_id="task-c", grading_type="automated"),
        ]

        selected = _select_tasks(tasks, "task-c,missing,task-a,task-b", {})

        self.assertEqual(
            [task.task_id for task in selected],
            ["task-c", "task-a", "task-b"],
        )


if __name__ == "__main__":
    unittest.main()
