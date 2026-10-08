#!/usr/bin/env python3
"""Drive a terminal program in a pseudo-terminal and capture its screen with pyte.

Usage: pty_driver.py <script.json>

script.json:
{
  "cmd": ["bun", "src/main.ts"],
  "cwd": "/path", "env": {"K": "V"},
  "cols": 120, "rows": 36,
  "steps": [
    {"expect": "text", "timeout": 10},     # wait until text is on screen
    {"type": "hello"},                     # type characters
    {"key": "down"},                       # named key (see KEYS)
    {"sleep": 0.5},
    {"snapshot": "name"}                   # record the screen
  ]
}
Prints a JSON object {"snapshots": {name: screen_text}, "ok": bool, "error": str|null, "exit": code|null}.
"""
import json
import os
import pty
import select
import signal
import sys
import time

import pyte

KEYS = {
    "enter": "\r",
    "return": "\r",
    "tab": "\t",
    "shift-tab": "\x1b[Z",
    "esc": "\x1b",
    "escape": "\x1b",
    "backspace": "\x7f",
    "up": "\x1b[A",
    "down": "\x1b[B",
    "right": "\x1b[C",
    "left": "\x1b[D",
    "shift-up": "\x1b[1;2A",
    "shift-down": "\x1b[1;2B",
    "pageup": "\x1b[5~",
    "pagedown": "\x1b[6~",
    "f1": "\x1bOP",
    "space": " ",
}


def ctrl(ch):
    return chr(ord(ch.lower()) - 96)


def main():
    spec = json.load(open(sys.argv[1]))
    cols, rows = spec.get("cols", 120), spec.get("rows", 36)
    screen = pyte.Screen(cols, rows)
    stream = pyte.ByteStream(screen)
    env = dict(os.environ)
    env.update(spec.get("env", {}))
    env["TERM"] = env.get("TERM_OVERRIDE", "xterm-256color")
    env["COLUMNS"], env["LINES"] = str(cols), str(rows)

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(spec.get("cwd", os.getcwd()))
        import fcntl, struct, termios

        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.execvpe(spec["cmd"][0], spec["cmd"], env)

    import fcntl, struct, termios

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    out = {"snapshots": {}, "ok": True, "error": None, "exit": None, "stdout_tail": ""}
    raw = bytearray()

    def pump(timeout):
        end = time.time() + timeout
        while True:
            left = end - time.time()
            if left <= 0:
                return True
            r, _, _ = select.select([fd], [], [], min(left, 0.05))
            if fd in r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return False
                if not data:
                    return False
                raw.extend(data)
                # Answer cursor position requests so the app does not wait for them.
                if b"\x1b[6n" in data:
                    os.write(fd, f"\x1b[{screen.cursor.y + 1};{screen.cursor.x + 1}R".encode())
                stream.feed(data)

    def text():
        return "\n".join(line.rstrip() for line in screen.display)

    def send(s):
        os.write(fd, s.encode())

    alive = True
    try:
        for step in spec["steps"]:
            if not alive:
                break
            if "sleep" in step:
                alive = pump(step["sleep"])
            elif "expect" in step:
                deadline = time.time() + step.get("timeout", 10)
                while step["expect"] not in text():
                    if time.time() > deadline:
                        out["ok"] = False
                        out["error"] = f"timed out waiting for {step['expect']!r}"
                        out["snapshots"]["__timeout__"] = text()
                        raise StopIteration
                    alive = pump(0.1)
                    if not alive:
                        break
            elif "expect_not" in step:
                deadline = time.time() + step.get("timeout", 10)
                while step["expect_not"] in text():
                    if time.time() > deadline:
                        out["ok"] = False
                        out["error"] = f"timed out waiting for {step['expect_not']!r} to disappear"
                        out["snapshots"]["__timeout__"] = text()
                        raise StopIteration
                    alive = pump(0.1)
            elif "type" in step:
                for ch in step["type"]:
                    send(ch)
                    pump(step.get("delay", 0.02))
            elif "key" in step:
                k = step["key"]
                send(ctrl(k[5:]) if k.startswith("ctrl-") else KEYS[k])
                alive = pump(step.get("delay", 0.15))
            elif "raw" in step:
                send(step["raw"])
                alive = pump(0.1)
            elif "snapshot" in step:
                pump(step.get("settle", 0.3))
                out["snapshots"][step["snapshot"]] = text()
            elif "wait_exit" in step:
                # The terminal can close (EOF) a moment before the exit status is available,
                # so keep polling waitpid until the deadline either way.
                deadline = time.time() + step["wait_exit"]
                open_fd = True
                while time.time() < deadline:
                    if open_fd:
                        open_fd = pump(0.1)
                    else:
                        time.sleep(0.05)
                    done, status = os.waitpid(pid, os.WNOHANG)
                    if done:
                        out["exit"] = os.waitstatus_to_exitcode(status)
                        if open_fd:
                            pump(0.2)  # drain the last output
                        break
    except StopIteration:
        pass
    finally:
        if out["exit"] is None:
            try:
                done, status = os.waitpid(pid, os.WNOHANG)
                if done:
                    out["exit"] = os.waitstatus_to_exitcode(status)
                else:
                    os.kill(pid, signal.SIGTERM)
                    time.sleep(0.3)
                    done, status = os.waitpid(pid, os.WNOHANG)
                    if not done:
                        os.kill(pid, signal.SIGKILL)
                        os.waitpid(pid, 0)
            except ChildProcessError:
                pass
        out["stdout_tail"] = raw[-2000:].decode("utf-8", "replace")
        out["final"] = text()
    print(json.dumps(out))


if __name__ == "__main__":
    main()
