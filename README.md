# Agentic Bridge

Connect DeepSeek AI chat to your local MSYS2 terminal. AI writes bash scripts, bridge executes them on your system, results flow back automatically.

![Screenshot](pic.jpg)

## How it works

DeepSeek AI generates a bash script in chat. The bridge detects it, adds an EXEC BASH button, runs it on your MSYS2 system via WebSocket, and sends output back to the chat. In AGENT mode this loops automatically — AI writes code, bridge runs it, AI reads results and continues.

## Setup

1. Install `agent.js` in Tampermonkey/Greasemonkey (active on `chat.deepseek.com`)
2. Install Python dependency: `pip install websockets` (for msys ucrt its `mingw-w64-ucrt-x86_64-python-websockets`).
3. Start the bridge: `python3 bridge.py`
4. Open https://chat.deepseek.com

## Modes

- **AGENT** — Full auto loop (exec + send + continue)
- **AUTO-EXEC** — Execute scripts automatically
- **AUTO-SEND** — Send results back automatically
- **LOGIN** — Use bash login shell (loads .bashrc)
- **Scan** — Manually find scripts in messages

## Whats next

Try to adapt it for your host or AI of preference!
