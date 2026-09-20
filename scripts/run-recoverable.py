#!/usr/bin/env python3
"""Run Linty with bounded restart-on-crash supervision (no login service installed)."""
import argparse
from collections import deque
import signal
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--restart-delay', type=float, default=1)
    parser.add_argument('--max-restarts', type=int, default=3)
    parser.add_argument('--window', type=float, default=60)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command
    if command[:1] == ['--']:
        command = command[1:]
    if not command or args.restart_delay < 0 or args.max_restarts < 0 or args.window <= 0:
        parser.error('Provide a command and nonnegative restart settings.')
    stopped = False
    child = None

    def stop(signum, _frame):
        nonlocal stopped
        stopped = True
        if child is not None and child.poll() is None:
            try:
                child.send_signal(signum)
            except ProcessLookupError:
                pass

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    crashes = deque()
    while not stopped:
        try:
            child = subprocess.Popen(command)
        except OSError as error:
            print(f'[supervisor] Could not launch Linty: {error}', file=sys.stderr, flush=True)
            return 1
        print(f'[supervisor] Started process {child.pid}', file=sys.stderr, flush=True)
        if stopped:
            child.terminate()
        code = child.wait()
        # Normal menu Quit and explicit termination stay quit.
        if stopped or code in (0, -signal.SIGTERM, -signal.SIGINT):
            return 0
        now = time.monotonic()
        while crashes and now - crashes[0] > args.window:
            crashes.popleft()
        if len(crashes) >= args.max_restarts:
            print('[supervisor] Repeated crashes; automatic restart stopped. Check the app log.', file=sys.stderr, flush=True)
            return 1
        crashes.append(now)
        delay = min(args.restart_delay * 2 ** (len(crashes) - 1), 10)
        print(f'[supervisor] Process exited {code}; restarting in {delay:g}s', file=sys.stderr, flush=True)
        # Check termination while backing off so Quit never schedules a relaunch.
        deadline = time.monotonic() + delay
        while not stopped and time.monotonic() < deadline:
            time.sleep(min(.1, max(0, deadline - time.monotonic())))
    return 0


if __name__ == '__main__':
    sys.exit(main())
