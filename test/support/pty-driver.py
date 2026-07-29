#!/usr/bin/env python3
import os
import pty
import select
import signal
import sys

if len(sys.argv) < 3:
    raise SystemExit("usage: pty-driver.py <input-hex> <command> [args ...]")

input_bytes = bytes.fromhex(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])

if input_bytes:
    os.write(fd, input_bytes)
output = bytearray()
while True:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if fd in ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            chunk = b""
        if chunk:
            output.extend(chunk)
    finished, status = os.waitpid(pid, os.WNOHANG)
    if finished:
        while True:
            ready, _, _ = select.select([fd], [], [], 0)
            if fd not in ready:
                break
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            output.extend(chunk)
        sys.stdout.buffer.write(output)
        if os.WIFEXITED(status):
            raise SystemExit(os.WEXITSTATUS(status))
        if os.WIFSIGNALED(status):
            os.kill(os.getpid(), os.WTERMSIG(status))
        raise SystemExit(1)
