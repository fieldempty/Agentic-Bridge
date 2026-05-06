#!/usr/bin/env python3
import asyncio
import websockets
import json
import os
import platform
import sys
import subprocess
import time
import hashlib
import shutil
from datetime import datetime

LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent_logs")
PATCH_DIR = os.path.join(LOG_DIR, "patches")
os.makedirs(PATCH_DIR, exist_ok=True)

# ANSI colors
GREEN = '\033[92m'
RED = '\033[91m'
YELLOW = '\033[93m'
CYAN = '\033[96m'
RESET = '\033[0m'

import ctypes
kernel32 = ctypes.windll.kernel32
kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)

def log_event(event_type, details="", color=""):
    """Write log with timestamp. color: 'READ','WRITE','EXEC','INFO'"""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    log_file = os.path.join(LOG_DIR, f"agent_{datetime.now().strftime('%Y%m%d')}.log")
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(f"[{timestamp}] {event_type}: {details}\n")
    colors = {'READ': GREEN, 'WRITE': RED, 'EXEC': YELLOW, 'INFO': CYAN}
    c = colors.get(color, '')
    print(f"{c}[{timestamp}] [{color}] {details}{RESET}")

def snapshot_file(filepath):
    if not os.path.exists(filepath):
        return None
    try:
        with open(filepath, "rb") as f:
            content = f.read()
        h = hashlib.sha256(content).hexdigest()[:8]
        snapshot_path = os.path.join(PATCH_DIR, f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{os.path.basename(filepath)}_{h}.bak")
        shutil.copy2(filepath, snapshot_path)
        size = len(content)
        log_event("SNAPSHOT", f"{filepath} -> {os.path.basename(snapshot_path)} ({size}B, {h})", "INFO")
        return snapshot_path
    except Exception as e:
        log_event("SNAPSHOT_FAIL", f"{filepath}: {e}", "INFO")
        return None

def create_patch(filepath, old_snapshot):
    if not old_snapshot or not os.path.exists(filepath):
        return None
    try:
        patch_file = old_snapshot + ".patch"
        result = subprocess.run(["diff", "-u", old_snapshot, filepath], capture_output=True, text=True)
        if result.stdout:
            with open(patch_file, "w") as f:
                f.write(result.stdout)
            log_event("PATCH", f"{os.path.basename(patch_file)} ({len(result.stdout)}B)", "INFO")
            return patch_file
    except Exception as e:
        log_event("PATCH_FAIL", f"{filepath}: {e}", "INFO")
    return None

def cmd_preview(command):
    """Show meaningful snippet instead of 'bash -c'"""
    cmd = command.strip()
    # Remove heredoc content for display
    if '<<' in cmd:
        lines = cmd.split('\n')
        preview = '; '.join([l.strip() for l in lines[:2] if l.strip() and 'EOF' not in l])
        if len(preview) > 80:
            preview = preview[:77] + '...'
        return preview
    if len(cmd) > 80:
        return cmd[:77] + '...'
    return cmd

async def handle_connection(websocket):
    peer = websocket.remote_address
    log_event("CONNECT", f"Client {peer[0]}:{peer[1]}", "INFO")
    bytes_rx = 0
    bytes_tx = 0
    
    try:
        async for message in websocket:
            bytes_rx += len(message)
            try:
                data = json.loads(message)
                command = data.get('command', '')
                use_login = data.get('login_shell', False)
                cmd_id = data.get('id', 'unknown')
                
                preview = cmd_preview(command)
                log_event("READ", f"id={cmd_id[:16]} shell={'login' if use_login else 'bare'} | {preview}", "READ")
                
                bash_paths = [
                    r'C:\msys64\usr\bin\bash.exe',
                    r'C:\msys64\ucrt64\bin\bash.exe',
                    r'C:\msys64\mingw64\bin\bash.exe',
                ]
                bash_exe = None
                for p in bash_paths:
                    if os.path.exists(p):
                        bash_exe = p
                        break
                if not bash_exe:
                    bash_exe = 'bash'
                
                shell_cmd = [bash_exe, '-lc', command] if use_login else [bash_exe, '-c', command]
                
                start_time = time.time()
                process = await asyncio.create_subprocess_exec(
                    *shell_cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT
                )
                
                output_chunks = []
                while True:
                    line = await process.stdout.readline()
                    if not line:
                        break
                    decoded = line.decode('utf-8', errors='replace')
                    output_chunks.append(decoded)
                    tx_msg = json.dumps({'type': 'stream', 'data': decoded})
                    await websocket.send(tx_msg)
                    bytes_tx += len(tx_msg)
                
                await process.wait()
                elapsed = time.time() - start_time
                
                full_output = ''.join(output_chunks)
                log_event("WRITE", f"exit={process.returncode} time={elapsed:.2f}s sent={bytes_tx}B out={len(full_output)}B", "WRITE")
                
                result_msg = json.dumps({'type': 'done', 'code': process.returncode})
                await websocket.send(result_msg)
                bytes_tx += len(result_msg)
                
            except json.JSONDecodeError as e:
                log_event("ERROR", f"Parse: {e}", "INFO")
                await websocket.send(json.dumps({'type': 'error', 'data': str(e)}))
            except Exception as e:
                log_event("ERROR", str(e), "INFO")
                try:
                    await websocket.send(json.dumps({'type': 'error', 'data': str(e)}))
                except:
                    pass
                    
    except websockets.exceptions.ConnectionClosed:
        log_event("CLOSE", f"Client disconnected. RX={bytes_rx}B TX={bytes_tx}B", "INFO")

async def main():
    print(f"{CYAN}{'='*60}{RESET}")
    print(f"{YELLOW}  Agentic Bridge Server v6{RESET}")
    print(f"{CYAN}{'='*60}{RESET}")
    print(f"  Platform: {platform.system()} {platform.machine()}")
    print(f"  Logs:     {LOG_DIR}")
    print(f"  {GREEN}[READ]{RESET} = command received  {RED}[WRITE]{RESET} = result sent")
    print(f"{CYAN}{'-'*60}{RESET}")
    
    log_event("START", f"Server v6", "INFO")
    
    async with websockets.serve(handle_connection, "localhost", 8765, max_size=2**20, ping_interval=None):
        print(f"  Listening on ws://localhost:8765")
        print(f"{CYAN}{'='*60}{RESET}")
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log_event("STOP", "Server stopped", "INFO")
        print(f"\n{YELLOW}Server stopped{RESET}")
    except Exception as e:
        log_event("FATAL", str(e), "INFO")
        print(f"{RED}Fatal: {e}{RESET}")
