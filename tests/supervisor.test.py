import pathlib
import subprocess
import sys
import tempfile
import unittest

RUNNER = pathlib.Path(__file__).resolve().parents[1] / 'scripts/run-recoverable.py'


class SupervisorTests(unittest.TestCase):
    def run_child(self, script, *arguments):
        return subprocess.run([sys.executable, str(RUNNER), '--restart-delay', '0.01', '--max-restarts', '2', '--', sys.executable, '-c', script, *arguments], capture_output=True, text=True, timeout=10)

    def test_clean_quit_is_not_restarted(self):
        result = self.run_child('print("launched")')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.count('launched'), 1)

    def test_crash_restarts_and_success_stops(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_child('import pathlib,sys; p=pathlib.Path(sys.argv[1]); n=int(p.read_text()) if p.exists() else 0; p.write_text(str(n+1)); sys.exit(1 if n == 0 else 0)', str(pathlib.Path(directory) / 'count'))
            self.assertEqual(result.returncode, 0)
            self.assertEqual((pathlib.Path(directory) / 'count').read_text(), '2')

    def test_crash_loop_is_bounded(self):
        result = self.run_child('print("launched"); raise SystemExit(1)')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.count('launched'), 3)
        self.assertIn('Repeated crashes', result.stderr)

    def test_explicit_termination_is_not_restarted(self):
        result = self.run_child('import os,signal; print("launched", flush=True); os.kill(os.getpid(),signal.SIGTERM)')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.count('launched'), 1)


if __name__ == '__main__':
    unittest.main()
