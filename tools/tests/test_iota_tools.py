"""Read-only guardian checks; never install or restart IOTA."""
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'tools/iota-local'
spec = importlib.util.spec_from_file_location('guardian', SOURCE / 'runtime/iota_guardian.py')
guardian = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guardian)


class GuardianChecks(unittest.TestCase):
    def setUp(self):
        self.now = 10000
        self.evidence = guardian.parse_logs([], {'session_started_at': 8000})
        self.evidence.update(last_activity_at=9990)
        self.control = {'ok': True, 'connected': True, 'expectedHostPid': 123}

    def classify(self, pid=123, alive=True):
        return guardian.classify(self.evidence, pid, alive, self.control, self.now)

    def test_stale_queue_does_not_restart(self):
        self.evidence.update(queue_status='queued', queue_position=287, queue_updated_at=8000)
        status, _, restart = self.classify()
        self.assertEqual(status, 'queued')
        self.assertFalse(restart)

    def test_normal_quit_preserves_manual_intent(self):
        self.evidence['quit_at'] = 9990
        self.assertEqual(self.classify(pid=None, alive=False)[0], 'paused')
        self.assertFalse(self.classify(pid=None, alive=False)[2])

    def test_normal_miner_stop_does_not_restart(self):
        self.evidence.update(exited_at=9990, exit_code=0)
        self.assertFalse(self.classify(alive=False)[2])

    def test_startup_grace(self):
        self.evidence['session_started_at'] = 9900
        self.control = None
        self.assertEqual(self.classify(alive=False)[0], 'starting')
        self.assertFalse(self.classify(alive=False)[2])

    def test_disconnected_control_is_local_failure(self):
        self.control['connected'] = False
        self.assertTrue(self.classify()[2])

    def test_three_checks_cooldown_and_hourly_limit(self):
        self.assertIsNone(guardian.decision({'bad_checks': 2}, self.now))
        self.assertEqual(guardian.decision({'bad_checks': 3}, self.now), 'restart')
        self.assertNotEqual(guardian.decision({'bad_checks': 3, 'last_restart_at': 9900}, self.now), 'restart')
        self.assertNotEqual(guardian.decision({'bad_checks': 3, 'restart_history': [7000, 8000, 9000]}, self.now), 'restart')

    def test_queue_log_retains_only_status_fields(self):
        records = [(9900, 'Successfully completed request to /miner/register response: {"status":"queued","position":42,"token":"fixture-token"}')]
        evidence = guardian.parse_logs(records, {})
        self.assertEqual(evidence['queue_position'], 42)
        self.assertEqual(evidence['queue_status'], 'queued')
        self.assertNotIn('fixture-token', json.dumps(evidence))


class CommandSyntaxChecks(unittest.TestCase):
    def test_commands_are_valid_zsh(self):
        import subprocess
        for file in SOURCE.glob('*.command'):
            subprocess.run(['/bin/zsh', '-n', str(file)], check=True)


if __name__ == '__main__':
    unittest.main()
