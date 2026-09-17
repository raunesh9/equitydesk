#!/usr/bin/env python3
"""Start the finished app using only Python, then open the default browser."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent
URL = "http://127.0.0.1:8765"

def running():
    try:
        with urllib.request.urlopen(URL + "/api/health", timeout=1) as response:
            return json.load(response).get("app") == "equitydesk"
    except (OSError, ValueError):
        return False

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-open", action="store_true")
    parser.add_argument("--stop", action="store_true")
    args = parser.parse_args()
    if args.stop:
        if running():
            request = urllib.request.Request(URL + "/api/shutdown", data=b"{}", headers={"Content-Type":"application/json","X-EquityDesk":"1"}, method="POST")
            with urllib.request.urlopen(request, timeout=5) as response:
                response.read()
            for _ in range(30):
                if not running():
                    break
                time.sleep(.1)
            print("EquityDesk stopped. Your saved data is kept.")
        else:
            print("EquityDesk is already stopped.")
        return 0
    if not (ROOT / "app/dist/client/index.html").exists():
        print("The app files are missing. Ask Codex to rebuild EquityDesk in this folder.")
        return 1
    if not running():
        logs = ROOT / "work"
        logs.mkdir(exist_ok=True)
        with (logs / "server.log").open("a") as output:
            runtime = ROOT / '.venv-yahoo/bin/python'
            if not runtime.exists():
                print('The Yahoo Finance environment is missing. Ask Codex to install requirements.txt for EquityDesk.')
                return 1
            process = subprocess.Popen([str(runtime), str(ROOT / "server.py")],
                cwd=str(ROOT), stdout=output, stderr=output, start_new_session=True)
        for _ in range(50):
            if running():
                break
            if process.poll() is not None:
                print("Could not start EquityDesk. Another program may be using port 8765. Ask Codex to check work/server.log.")
                return 1
            time.sleep(.2)
        else:
            print("The app did not start in time. Ask Codex to check work/server.log.")
            return 1
    if not args.no_open:
        subprocess.run(["open", URL], check=False)
    print("EquityDesk is running at " + URL)
    print("You can close this Terminal window. Use Stop EquityDesk.command when you want to stop the app.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
