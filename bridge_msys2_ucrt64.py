#!/usr/bin/env python3
import asyncio
import websockets
import json
import os
import platform
import sys

async def handle_connection(websocket):
    """Handle WebSocket connection"""
    print(f"Client connected")
    
    try:
        async for message in websocket:
            try:
                data = json.loads(message)
                command = data.get('command', '')
                use_login_shell = data.get('login_shell', False)  # Default: login shell
                
                print(f"Command: {command[:80]}...")
                print(f"Login shell: {use_login_shell}")
                
                # Find MSYS2 bash
                bash_paths = [
                    r'C:\msys64\usr\bin\bash.exe',
                    r'C:\msys64\ucrt64\bin\bash.exe',
                    r'C:\msys64\mingw64\bin\bash.exe',
                ]
                
                bash_exe = None
                for path in bash_paths:
                    if os.path.exists(path):
                        bash_exe = path
                        break
                
                if not bash_exe:
                    bash_exe = 'bash'
                
                # Build command based on login shell toggle
                if use_login_shell:
                    shell_cmd = [bash_exe, '-lc', command]  # Login shell (loads profile/SSH)
                else:
                    shell_cmd = [bash_exe, '-c', command]   # Regular shell (no profile)
                
                print(f"Executing: {bash_exe} {'-lc' if use_login_shell else '-c'} ...")
                
                process = await asyncio.create_subprocess_exec(
                    *shell_cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT
                )
                
                # Stream output
                while True:
                    line = await process.stdout.readline()
                    if not line:
                        break
                    decoded = line.decode('utf-8', errors='replace')
                    await websocket.send(json.dumps({
                        'type': 'stream',
                        'data': decoded
                    }))
                
                await process.wait()
                
                await websocket.send(json.dumps({
                    'type': 'done',
                    'code': process.returncode
                }))
                
                print(f"Completed with exit code: {process.returncode}")
                
            except Exception as e:
                print(f"Error: {e}")
                try:
                    await websocket.send(json.dumps({
                        'type': 'error',
                        'data': str(e)
                    }))
                except:
                    pass
                    
    except websockets.exceptions.ConnectionClosed:
        print("Client disconnected")

async def main():
    print("=" * 50)
    print("MSYS2 Bridge Server v4")
    print("=" * 50)
    print(f"Platform: {platform.system()}")
    print("Supports: Login shell (bash -lc) or Regular (bash -c)")
    print("-" * 50)
    
    host = "localhost"
    port = 8765
    
    print(f"Starting ws://{host}:{port}")
    print("=" * 50)
    
    async with websockets.serve(
        handle_connection,
        host,
        port,
        max_size=2**20,
        ping_interval=None
    ):
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nServer stopped")
    except Exception as e:
        print(f"Fatal: {e}")