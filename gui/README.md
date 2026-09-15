# Leela Zero desktop GUI (Windows)

A front window for analysing and playing Go with **KataGo** or **Leela Zero**:
board-first layout with candidates, main line, game record, evaluation (win
rate, score lead, visits, speed), network policy, variations, territory and a
win-rate timeline.

The engines do all Go thinking. Credit where it belongs:

- **KataGo** by David J. Wu (lightvector) — https://github.com/lightvector/KataGo
- **Leela Zero** by Gian-Carlo Pascutto and contributors — https://github.com/leela-zero/leela-zero

## How it is built

| Part | What it does |
|---|---|
| `host/main.cpp` | Win32 window with a WebView2 control. Starts engine processes (GTP over pipes), open/save dialogs, settings file. No Go logic. |
| `ui/` | The interface (HTML/CSS/JS, no frameworks, no downloads at runtime). |
| `ui/js/go.js` | Rules (captures, ko, suicide), GTP coordinates, SGF main line. |
| `ui/js/gtp.js` | GTP client: command queue, streaming `kata-analyze` / `lz-analyze`, `kata-raw-nn` parser. |
| `ui/js/board.js`, `panels.js`, `app.js` | Board rendering, panels, state and engine control. |
| `webview2/` | Vendored Microsoft WebView2 SDK 1.0.4191.47 (header, loader DLL, import library; BSD license). |

Page and host exchange tab-separated strings (page → host) and JSON (host →
page); the format is documented at the top of `host/main.cpp`.

## Build

With the main project (MSYS2 MinGW or MSVC), the GUI is on by default on Windows:

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release   # -DBUILD_GUI=OFF to skip it
cmake --build build --target leelaz-gui
```

The build copies `WebView2Loader.dll` and `ui/` next to `leelaz-gui.exe`.

## Package layout

The exe looks for engines next to itself:

```
leelaz-gui.exe
WebView2Loader.dll
ui/
engines/katago/   katago.exe + DLLs, gtp_cpu.cfg, b18c384nbt.bin.gz
engines/leelaz/   leelaz.exe + DLLs, best-network (40x256), networks/leelaz-6b-fast.gz
```

Target PCs need the Microsoft Edge WebView2 Runtime (included with Windows 11).
Settings are stored in `%LOCALAPPDATA%\LeelaZeroGUI\settings.json`.

## Tests

Logic tests run with any Node.js (VS Code's bundled one works without installing anything):

```sh
ELECTRON_RUN_AS_NODE=1 "<VS Code>/Code.exe" gui/tests/go.test.js
ELECTRON_RUN_AS_NODE=1 "<VS Code>/Code.exe" gui/tests/gtp.test.js
```

End-to-end self test with the real engines — the window runs a scenario and
saves a screenshot, exit code 0 on success (2 = timed out, screenshot still saved):

```sh
leelaz-gui.exe --selftest out.png                       # KataGo 19x19, 1920x1080
leelaz-gui.exe --selftest out.png kata9                 # KataGo 9x9 with territory
leelaz-gui.exe --selftest out.png leelaz19 1100x640     # Leela Zero, smallest window
leelaz-gui.exe --selftest out.png review19              # "Analyze game" over all moves
```
