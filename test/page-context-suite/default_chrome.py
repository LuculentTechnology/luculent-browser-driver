# Helpers for the Default Chrome UI page-context tests.
# Subcommands: list | restart | screenshot
# Never touches Chrome processes that use a non-default --user-data-dir.
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

STANDARD = os.path.normcase(os.path.normpath(os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\User Data")))

def _cmd_output(args: list[str]) -> str:
    r = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return (r.stdout or "") + (r.stderr or "")

def chrome_processes() -> list[dict]:
    ps = r"""
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Select-Object ProcessId, ExecutablePath, CommandLine |
  ForEach-Object {
    $p = $_.ProcessId
    $e = $_.ExecutablePath
    $c = $_.CommandLine
    if (-not $c) { $c = '' }
    Write-Output ("PID=" + $p + "`tEXE=" + $e + "`tCMD=" + $c)
  }
"""
    out = _cmd_output(["powershell", "-NoProfile", "-Command", ps])
    rows = []
    for line in out.splitlines():
        if not line.startswith("PID="):
            continue
        try:
            pid_s, rest = line.split("\tEXE=", 1)
            exe, cmd = rest.split("\tCMD=", 1)
            rows.append({"pid": int(pid_s[4:]), "exe": exe.strip(), "cmd": cmd})
        except Exception:
            continue
    return rows

def user_data_dir(cmd: str) -> str | None:
    if "--user-data-dir" not in cmd:
        return None
    # --user-data-dir=PATH or --user-data-dir PATH
    parts = cmd.split("--user-data-dir", 1)[1]
    if parts.startswith("="):
        parts = parts[1:]
    parts = parts.strip()
    if parts.startswith('"'):
        end = parts.find('"', 1)
        val = parts[1:end] if end > 0 else parts[1:]
    else:
        val = parts.split(" ", 1)[0]
    return os.path.normcase(os.path.normpath(val.strip().strip('"')))

def is_default(cmd: str) -> bool:
    udd = user_data_dir(cmd)
    if udd is None:
        return True
    return udd == STANDARD

def default_procs() -> list[dict]:
    return [p for p in chrome_processes() if is_default(p["cmd"])]

def other_procs() -> list[dict]:
    return [p for p in chrome_processes() if not is_default(p["cmd"])]

def chrome_exe(procs: list[dict] | None = None) -> str:
    for p in (procs or default_procs()):
        if p.get("exe") and os.path.isfile(p["exe"]):
            return p["exe"]
    for cand in (
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    ):
        if os.path.isfile(cand):
            return cand
    raise SystemExit("chrome.exe not found")

def cmd_list(_args: argparse.Namespace) -> int:
    d = default_procs()
    o = other_procs()
    mains = [p for p in d if "--type=" not in p["cmd"]]
    print("default_mains=" + str(len(mains)))
    print("default_total=" + str(len(d)))
    print("other_mains=" + str(len([p for p in o if "--type=" not in p["cmd"]])))
    print("other_total=" + str(len(o)))
    if mains and mains[0].get("exe"):
        print("exe=" + mains[0]["exe"])
    for p in mains:
        print("main_pid=" + str(p["pid"]))
    return 0

def _kill(pids: list[int], force: bool) -> None:
    for pid in pids:
        args = ["taskkill", "/PID", str(pid)]
        if force:
            args.append("/F")
        subprocess.run(args, capture_output=True)

def cmd_restart(args: argparse.Namespace) -> int:
    before_others = {p["pid"] for p in other_procs()}
    d = default_procs()
    exe = args.chrome or chrome_exe(d)
    mains = [p["pid"] for p in d if "--type=" not in p["cmd"]]
    all_pids = [p["pid"] for p in d]
    print("restart_exe=" + exe)
    print("closing_mains=" + ",".join(str(x) for x in mains))
    if all_pids:
        _kill(mains or all_pids, force=False)
        deadline = time.time() + 20
        while time.time() < deadline:
            live = {p["pid"] for p in default_procs()}
            if not live:
                break
            time.sleep(0.5)
        live = [p["pid"] for p in default_procs()]
        if live:
            _kill(live, force=True)
            time.sleep(1.5)
    # never leave non-default chromes disturbed
    after_others = {p["pid"] for p in other_procs()}
    missing = before_others - after_others
    if missing:
        print("warning_other_chrome_pids_gone=" + ",".join(str(x) for x in sorted(missing)))
    if getattr(args, "flush_sw_cache", False):
        sw_dir = Path(STANDARD) / "Default" / "Service Worker"
        if sw_dir.exists():
            import shutil
            # Only the script cache for this profile, so an unpacked extension reload picks up new files.
            removed = 0
            for name in ("ScriptCache", "Database"):
                target = sw_dir / name
                if target.exists():
                    shutil.rmtree(target, ignore_errors=True)
                    removed += 1
            print("flushed_sw_cache=" + str(removed))
    creation = 0x00000008  # DETACHED_PROCESS
    flags = ["--restore-last-session", "--profile-directory=Default"]
    subprocess.Popen([exe, *flags], close_fds=True, creationflags=creation)
    print("started=1")
    return 0

def _enum_windows() -> list[tuple[int, str, tuple[int, int, int, int]]]:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    handles: list[tuple[int, str, tuple[int, int, int, int]]] = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        title = buf.value or ""
        if "Chrome" not in title and "Google Chrome" not in title:
            return True
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        handles.append((int(hwnd), title, (rect.left, rect.top, rect.right, rect.bottom)))
        return True

    user32.EnumWindows(cb, 0)
    return handles

def cmd_screenshot(args: argparse.Namespace) -> int:
    import ctypes
    from PIL import ImageGrab

    user32 = ctypes.windll.user32
    SW_RESTORE = 9
    needle = (args.title_substr or "").lower()
    wins = _enum_windows()
    if not wins:
        print("no_chrome_window")
        return 2
    chosen = None
    if needle:
        for w in wins:
            if needle in w[1].lower():
                chosen = w
                break
    if chosen is None:
        # prefer a large visible window (the browser), skip tiny popups
        sized = sorted(wins, key=lambda w: (w[2][2] - w[2][0]) * (w[2][3] - w[2][1]), reverse=True)
        chosen = sized[0]
    hwnd, title, box = chosen
    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.4)
    # refresh rect after restore
    wins2 = [w for w in _enum_windows() if w[0] == hwnd]
    if wins2:
        box = wins2[0][2]
    left, top, right, bottom = box
    if right - left < 50 or bottom - top < 50:
        print("tiny_window " + title)
        return 3
    img = ImageGrab.grab(bbox=(left, top, right, bottom))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    print("saved=" + str(out))
    print("title=" + title)
    print("box=" + ",".join(str(x) for x in box))
    return 0

def cmd_open_url(args: argparse.Namespace) -> int:
    exe = chrome_exe()
    url = args.url
    if not url.startswith("http://") and not url.startswith("https://"):
        raise SystemExit("url must be http(s)")
    subprocess.Popen(
        [exe, "--profile-directory=Default", url],
        close_fds=True,
        creationflags=0x00000008,
    )
    print("opened=" + url)
    return 0

def _pid_on_port(port: str) -> int | None:
    ps = (
        f"$c = Get-NetTCPConnection -LocalPort {int(port)} -State Listen -ErrorAction SilentlyContinue | "
        "Select-Object -First 1 -ExpandProperty OwningProcess; if ($c) { Write-Output $c }"
    )
    out = _cmd_output(["powershell", "-NoProfile", "-Command", ps]).strip()
    if out.isdigit():
        return int(out)
    return None

def cmd_relay_restart(args: argparse.Namespace) -> int:
    port = str(args.port)
    node = os.path.expandvars(r"%ProgramFiles%\nodejs\node.exe")
    winget_node = r"C:\Users\BATTLESTATION\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.19.0-win-x64\node.exe"
    cli = r"D:\Luculent\wt-browser-driver\tools\browser-driver\src\cli.mjs"
    cwd = r"D:\Luculent\wt-browser-driver\tools\browser-driver"
    exe = winget_node if os.path.isfile(winget_node) else (node if os.path.isfile(node) else "node")
    old = _pid_on_port(port)
    print("old_pid=" + (str(old) if old else "none"))
    if old:
        subprocess.run(["taskkill", "/PID", str(old)], capture_output=True)
        deadline = time.time() + 15
        while time.time() < deadline and _pid_on_port(port) == old:
            time.sleep(0.4)
        if _pid_on_port(port) == old:
            subprocess.run(["taskkill", "/PID", str(old), "/F"], capture_output=True)
            time.sleep(1)
    if _pid_on_port(port):
        print("port_still_busy")
        return 2
    log = Path(r"D:\Luculent\ops\state\relay-47800-restart.log")
    log.parent.mkdir(parents=True, exist_ok=True)
    lf = open(log, "a", encoding="utf-8")
    lf.write("\n--- restart " + time.strftime("%Y-%m-%d %H:%M:%S") + " ---\n")
    lf.flush()
    CREATE_NO_WINDOW = 0x08000000
    DETACHED = 0x00000008
    subprocess.Popen(
        [exe, cli, "start", "--port", port],
        cwd=cwd,
        stdout=lf,
        stderr=lf,
        close_fds=True,
        creationflags=CREATE_NO_WINDOW | DETACHED,
    )
    deadline = time.time() + 20
    pid = None
    while time.time() < deadline:
        pid = _pid_on_port(port)
        if pid:
            break
        time.sleep(0.4)
    print("new_pid=" + (str(pid) if pid else "none"))
    return 0 if pid else 3


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    p_restart = sub.add_parser("restart")
    p_restart.add_argument("--chrome")
    p_restart.add_argument("--flush-sw-cache", action="store_true")
    p_shot = sub.add_parser("screenshot")
    p_shot.add_argument("out")
    p_shot.add_argument("--title-substr", default="")
    p_open = sub.add_parser("open-url")
    p_open.add_argument("url")
    p_rel = sub.add_parser("relay-restart")
    p_rel.add_argument("--port", default="47800")
    args = ap.parse_args()
    if args.cmd == "list":
        return cmd_list(args)
    if args.cmd == "restart":
        return cmd_restart(args)
    if args.cmd == "screenshot":
        return cmd_screenshot(args)
    if args.cmd == "open-url":
        return cmd_open_url(args)
    if args.cmd == "relay-restart":
        return cmd_relay_restart(args)
    return 1

if __name__ == "__main__":
    sys.exit(main())
