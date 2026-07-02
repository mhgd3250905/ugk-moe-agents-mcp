#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any


def main() -> int:
    parser = argparse.ArgumentParser(description="Merge MCP server config into a UGK MCP config file.")
    parser.add_argument("--scope", choices=["install", "local", "project", "user"], required=True)
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--package-root", default=None)
    parser.add_argument("--input", required=True, help="JSON file containing either {mcpServers:{...}} or a raw server map")
    args = parser.parse_args()

    incoming = load_json(Path(args.input))
    servers = extract_servers(incoming)
    config_path = resolve_config_path(args.scope, Path(args.cwd), args.package_root)
    existing = load_existing_config(config_path)

    existing_servers = existing.setdefault("mcpServers", {})
    if not isinstance(existing_servers, dict):
        raise SystemExit(f"{config_path} has invalid mcpServers; expected object")

    for name, server in servers.items():
        validate_server(name, server)
        existing_servers[name] = server

    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(existing, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(
        json.dumps(
            {
                "ok": True,
                "scope": args.scope,
                "config_path": str(config_path),
                "server_count": len(servers),
                "servers": sorted(servers.keys()),
            },
            ensure_ascii=False,
        )
    )
    return 0


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise SystemExit(f"Invalid JSON in {path}: {error}") from error


def extract_servers(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise SystemExit("MCP config must be a JSON object")

    servers = payload.get("mcpServers", payload)
    if not isinstance(servers, dict) or not servers:
        raise SystemExit("MCP config must contain a non-empty mcpServers object")
    return servers


def resolve_config_path(scope: str, cwd: Path, package_root: str | None = None) -> Path:
    if scope == "install":
        return (Path(package_root) if package_root else find_package_root()) / "mcp.json"
    if scope == "local":
        return cwd / ".mcp.local.json"
    if scope == "project":
        return cwd / ".mcp.json"

    appdata = os.environ.get("APPDATA")
    if os.name == "nt" and appdata:
        return Path(appdata) / "ugk" / "mcp.json"
    return Path.home() / ".config" / "ugk" / "mcp.json"


def find_package_root() -> Path:
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "package.json").exists():
            return parent
    raise SystemExit("Could not locate UGK package root from configure_mcp.py")


def load_existing_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"mcpServers": {}}
    payload = load_json(path)
    if not isinstance(payload, dict):
        raise SystemExit(f"{path} must contain a JSON object")
    return payload


def validate_server(name: str, server: Any) -> None:
    if not isinstance(name, str) or not name:
        raise SystemExit("MCP server names must be non-empty strings")
    if not isinstance(server, dict):
        raise SystemExit(f'MCP server "{name}" must be an object')
    if not isinstance(server.get("command"), str) or not server["command"]:
        raise SystemExit(f'MCP server "{name}" command is required and must be a string')
    if "args" in server and not (
        isinstance(server["args"], list) and all(isinstance(item, str) for item in server["args"])
    ):
        raise SystemExit(f'MCP server "{name}" args must be a string array')
    if "env" in server and not (
        isinstance(server["env"], dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in server["env"].items())
    ):
        raise SystemExit(f'MCP server "{name}" env must be an object of string values')


if __name__ == "__main__":
    raise SystemExit(main())
