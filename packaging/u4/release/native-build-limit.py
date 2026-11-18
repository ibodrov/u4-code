#!/usr/bin/env python3
import fcntl
import os
import signal
import stat
import subprocess
import sys


def run(lock, command):
    fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError("native command lock must be an owned 0600 regular file")
        fcntl.flock(fd, fcntl.LOCK_EX)
        child = None
        pending = []

        def forward(signum, _frame):
            if child is None:
                pending.append(signum)
            else:
                child.send_signal(signum)

        for signum in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]:
            signal.signal(signum, forward)
        # Both processes retain the lock; killing this waiter cannot free a live command's slot.
        child = subprocess.Popen(command, pass_fds=(fd,))
        for signum in pending:
            child.send_signal(signum)
        status = child.wait()
    finally:
        os.close(fd)
    if status < 0:
        signum = -status
        if signum not in (signal.SIGKILL, signal.SIGSTOP):
            signal.signal(signum, signal.SIG_DFL)
        os.kill(os.getpid(), signum)
    return status


if __name__ == "__main__":
    try:
        if len(sys.argv) < 3:
            raise ValueError("usage: native-build-limit.py LOCK COMMAND [ARG ...]")
        sys.exit(run(sys.argv[1], sys.argv[2:]))
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
