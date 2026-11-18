#!/usr/bin/env python3
"""Capture short native OMP scenarios using an existing isolated credential copy.

Example:
  python3 record-omp-rpc-fixture.py --binary /path/to/omp \
    --home /tmp/capture/home --agent-dir /tmp/capture/agent \
    --workspace /tmp/capture/work --sessions /tmp/capture/sessions \
    --prompts /tmp/capture/prompts.json --output /tmp/capture/output.json

prompts.json is an array of prompt strings. Approval dialogs are recorded and denied.
Review and sanitize the output before committing it. Never pass live home/session paths.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading

parser = argparse.ArgumentParser(description=__doc__)
for name in ("binary", "home", "agent-dir", "workspace", "sessions", "prompts", "output"):
    parser.add_argument("--" + name, required=True)
args = parser.parse_args()
temp = Path(tempfile.gettempdir()).resolve()
for name in ("home", "agent_dir", "workspace", "sessions", "output"):
    path = Path(getattr(args, name)).resolve()
    if not path.is_relative_to(temp):
        parser.error(name + " must be beneath the temporary directory")
    (path.parent if name == "output" else path).mkdir(parents=True, exist_ok=True)
if not Path(args.agent_dir).resolve().is_relative_to(temp):
    parser.error("agent-dir must be a temporary copy of provider configuration and credentials")
env = dict(os.environ, HOME=args.home, PI_CODING_AGENT_DIR=args.agent_dir,
           PI_CONFIG_DIR=".omp", OMP_PROFILE="", PI_PROFILE="")
process = subprocess.Popen([
    args.binary, "--mode", "rpc-ui", "--session-dir", args.sessions,
    "--provider", "openai-codex", "--model", "gpt-6-luna", "--thinking", "low",
    "--max-cost", "0.10", "--no-title", "--no-extensions", "--no-skills",
    "--no-context-files", "--no-rules", "--no-lsp", "--no-prewalk",
    "--approval-mode", "always-ask",
], cwd=args.workspace, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
   stderr=subprocess.DEVNULL, text=True)
entries = []
deadline = threading.Timer(300, process.terminate)
deadline.start()

def send(frame):
    entries.append({"direction": "out", "frame": frame})
    process.stdin.write(json.dumps(frame) + "\n")
    process.stdin.flush()

def read():
    line = process.stdout.readline()
    if not line:
        raise RuntimeError("OMP closed stdout before the scenario completed")
    frame = json.loads(line)
    entries.append({"direction": "in", "frame": frame})
    if frame.get("type") == "extension_ui_request" and frame.get("method") in ("select", "confirm", "input", "editor"):
        send({"type": "extension_ui_response", "id": frame["id"], "cancelled": True})
    return frame

try:
    if read().get("type") != "ready":
        raise RuntimeError("OMP did not emit ready")
    send({"id": "protocol", "type": "negotiate_protocol", "protocolVersion": 2})
    send({"id": "projection", "type": "set_event_filter", "events": None, "messageUpdates": "delta"})
    send({"id": "children", "type": "set_subagent_subscription", "level": "progress"})
    prompts = json.loads(Path(args.prompts).read_text())
    if not isinstance(prompts, list) or not all(isinstance(p, str) for p in prompts):
        raise ValueError("prompts must be an array of strings")
    for number, prompt in enumerate(prompts):
        request_id = "capture-" + str(number)
        send({"id": request_id, "type": "prompt", "message": prompt})
        while True:
            frame = read()
            if frame.get("type") == "prompt_result" and frame.get("id") == request_id:
                break
        if not frame.get("sessionSettled", True):
            while read().get("type") != "session_settled":
                pass
    send({"id": "cost", "type": "get_session_stats"})
    while True:
        frame = read()
        if frame.get("type") == "response" and frame.get("id") == "cost":
            print("Parent session reported USD:", frame.get("data", {}).get("cost"))
            break
finally:
    Path(args.output).write_text(json.dumps(entries, indent=2) + "\n")
    process.terminate()
    process.wait()
    deadline.cancel()
