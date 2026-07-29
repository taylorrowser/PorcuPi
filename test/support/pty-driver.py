#!/usr/bin/env python3
import os
import pty
import select
import signal
import sys

if len(sys.argv) < 3:
    raise SystemExit("usage: pty-driver.py <input-hex> <command> [args ...]")

input_bytes = bytes.fromhex(sys.argv[1])
initial_input = bytes.fromhex(os.environ.get("PTY_INITIAL_INPUT_HEX", ""))
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])

initial_wait_for = os.environ.get("PTY_INITIAL_WAIT_FOR", "").encode()
initial_pending = bool(initial_input)
if initial_pending and not initial_wait_for:
    os.write(fd, initial_input)
    initial_pending = False
wait_for = os.environ.get("PTY_WAIT_FOR", "").encode()
input_pending = bool(input_bytes)
if input_pending and not wait_for:
    os.write(fd, input_bytes)
    input_pending = False
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
            if initial_pending and initial_wait_for in output:
                os.write(fd, initial_input)
                initial_pending = False
            if input_pending and wait_for in output:
                os.write(fd, input_bytes)
                input_pending = False
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
