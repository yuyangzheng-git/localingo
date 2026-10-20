"""Admin commands: `localingo-server serve | create-user | set-password`."""

from __future__ import annotations

import argparse
import getpass
import sys

from . import auth
from .config import Settings
from .db import Database


def _read_password(confirm: bool = True) -> str:
    password = getpass.getpass("密码（至少 10 位）: ")
    if confirm and getpass.getpass("再输入一次: ") != password:
        raise SystemExit("两次输入的密码不一致")
    return password


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="localingo-server")
    sub = ap.add_subparsers(dest="cmd", required=True)
    serve = sub.add_parser("serve", help="run the server")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8080)
    cu = sub.add_parser("create-user", help="create an account")
    cu.add_argument("username")
    sp = sub.add_parser("set-password", help="change a password (signs the user out everywhere)")
    sp.add_argument("username")
    args = ap.parse_args(argv)

    if args.cmd == "serve":
        import uvicorn

        uvicorn.run("localingo_server.app:app", host=args.host, port=args.port, proxy_headers=True)
        return 0

    db = Database(Settings().db_path)
    try:
        if args.cmd == "create-user":
            auth.create_user(db, args.username, _read_password())
            print(f"已创建用户 {args.username.lower()}")
        elif args.cmd == "set-password":
            auth.set_password(db, args.username, _read_password())
            print("密码已更新，所有设备需要重新登录")
    except ValueError as err:
        print(f"错误：{err}", file=sys.stderr)
        return 1
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
