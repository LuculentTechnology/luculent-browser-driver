# Open the Luculent side panel with a real user click on "Open chat panel".
import ctypes
import subprocess
import sys
import time
from collections import defaultdict

ctypes.windll.shcore.SetProcessDpiAwareness(2)

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
POPUP = "chrome-extension://oddcfadbpoapebpdmfbggiiibpbcpdoo/popup.html"
PURPLE = (0x4F, 0x46, 0xE5)

def click(x, y):
    ctypes.windll.user32.SetCursorPos(int(x), int(y))
    time.sleep(0.08)
    ctypes.windll.user32.mouse_event(2, 0, 0, 0, 0)
    ctypes.windll.user32.mouse_event(4, 0, 0, 0, 0)

def shot():
    from PIL import ImageGrab
    return ImageGrab.grab().convert("RGB")

def blobs(im, x0, x1, tol=12):
    w, h = im.size
    px = im.load()
    hits = []
    for y in range(0, h, 1):
        for x in range(max(0, x0), min(w, x1)):
            r, g, b = px[x, y]
            if abs(r - PURPLE[0]) <= tol and abs(g - PURPLE[1]) <= tol and abs(b - PURPLE[2]) <= 20:
                hits.append((x, y))
    sset = set(hits)
    seen = set()
    out = []
    for p in hits:
        if p in seen:
            continue
        stack = [p]
        seen.add(p)
        blob = [p]
        while stack:
            x, y = stack.pop()
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (2, 0), (-2, 0), (0, 2), (0, -2)):
                q = (x + dx, y + dy)
                if q in sset and q not in seen:
                    seen.add(q)
                    stack.append(q)
                    blob.append(q)
        xs = [a for a, _ in blob]
        ys = [b for _, b in blob]
        out.append((min(xs), min(ys), max(xs), max(ys), len(blob)))
    out.sort(key=lambda b: -b[4])
    return out

def right_panel_open(im):
    w, h = im.size
    px = im.load()
    dark = tot = 0
    for y in range(0, h, 4):
        for x in range(w - 600, w, 4):
            r, g, b = px[x, y]
            tot += 1
            if r < 30 and g < 30 and b < 40:
                dark += 1
    return (dark / tot) > 0.4 if tot else False

def main():
    im = shot()
    if right_panel_open(im):
        print("already_open=1")
        return 0
    subprocess.Popen([CHROME, "--profile-directory=Default", POPUP], close_fds=True, creationflags=0x00000008)
    time.sleep(2.2)
    im = shot()
    found = blobs(im, 0, 700)
    print("blobs", found[:5])
    cand = None
    for b in found:
        bw, bh = b[2] - b[0], b[3] - b[1]
        if bw >= 200 and bh <= 120 and b[4] >= 200:
            cand = b
            break
    if not cand and found:
        cand = found[0]
    if not cand:
        print("no_purple_button")
        return 2
    cx, cy = (cand[0] + cand[2]) // 2, (cand[1] + cand[3]) // 2
    print("click", cx, cy, "box", cand)
    click(cx, cy)
    time.sleep(1.2)
    im = shot()
    print("opened=" + ("1" if right_panel_open(im) else "0"))
    return 0 if right_panel_open(im) else 3

if __name__ == "__main__":
    raise SystemExit(main())
