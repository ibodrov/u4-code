#!/usr/bin/env python3
import ctypes
import os
import signal
import subprocess


class OwnedProcesses:
    def __init__(self):
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "cannot become child subreaper")
        self.process = None
        self.reaped = []
        signal.signal(signal.SIGTERM, self.interrupted)
        signal.signal(signal.SIGINT, self.interrupted)

    def interrupted(self, signum, _frame):
        self.stop()
        raise SystemExit(128 + signum)

    def children(self):
        with open(f"/proc/self/task/{os.getpid()}/children") as stream:
            return [int(pid) for pid in stream.read().split()]

    def stop(self):
        if self.process and self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.wait()
        self.process = None
        # Subreaping retains ownership of daemonized descendants after their parents exit.
        while self.children():
            for pid in self.children():
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            try:
                pid, status = os.waitpid(-1, 0)
                self.reaped.append({"pid": pid, "status": status})
            except ChildProcessError:
                break

    def run(self, args, *, cwd, env, log):
        with open(log, "ab", buffering=0) as output:
            self.process = subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            pid = self.process.pid
            status = self.process.wait()
            self.reaped.append({"pid": pid, "status": status})
            self.process = None
            self.stop()
            if status:
                raise RuntimeError(f"command failed ({status}); inspect private build log {log}")
