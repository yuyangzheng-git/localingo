"""LocaLingo Learn server: accounts, sync API, dictionary API and the hosted web app."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field

from . import __version__, auth, sync
from .config import Settings
from .db import Database
from .dictionary import Dictionary

log = logging.getLogger("localingo")

# Files of the extension that make up the hosted web app (nothing else is served).
WEB_FILES = {"index.html", "index.css", "learn.html", "landing.js"}
WEB_DIRS = {"learn", "learning", "icons"}
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
)


class LoginRequest(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)
    device_label: str = Field(default="", max_length=80)


class SignupRequest(LoginRequest):
    pass


class PushRequest(BaseModel):
    device_id: str = Field(min_length=1, max_length=100)
    changes: dict


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    state: dict = {}

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        db = Database(settings.db_path, mysql_url=settings.mysql_url)
        dictionary = Dictionary(settings.dict_db_path, settings.dict_dir, settings.dict_variant)
        try:
            active = dictionary.ensure_loaded()
            log.info("dictionary: %s", active["pkg"] if active else "none installed")
        except Exception:  # noqa: BLE001 - a broken package must not stop sync
            log.exception("dictionary package could not be loaded")
        if settings.admin_user and settings.admin_password:
            try:
                auth.create_user(db, settings.admin_user, settings.admin_password)
                log.info("created user %s from LOCALINGO_ADMIN_USER", settings.admin_user)
            except ValueError as err:
                if "已存在" not in str(err):
                    raise
        state.update(db=db, dictionary=dictionary, throttle=auth.LoginThrottle())
        yield
        db.close()

    app = FastAPI(title="LocaLingo Learn server", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^chrome-extension://[a-p]{32}$",
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
        max_age=600,
    )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        if not request.url.path.startswith("/api/"):
            response.headers.setdefault("Content-Security-Policy", CSP)
            response.headers.setdefault("X-Frame-Options", "DENY")
        else:
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    def db() -> Database:
        return state["db"]

    def current_user(authorization: str | None = Header(default=None)) -> dict:
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(401, "需要登录")
        user = auth.user_for_token(state["db"], authorization[7:].strip())
        if not user:
            raise HTTPException(401, "登录已失效，请重新登录")
        return user

    def client_ip(request: Request) -> str:
        return request.client.host if request.client else "?"

    # --- health & auth ------------------------------------------------------------

    @app.get("/api/health")
    def health() -> dict:
        return {
            "status": "ok",
            "version": __version__,
            "dictionary": bool(state["dictionary"].info()),
            "signup": settings.allow_signup,
        }

    @app.post("/api/auth/login")
    def login(body: LoginRequest, request: Request) -> dict:
        ip = client_ip(request)
        throttle: auth.LoginThrottle = state["throttle"]
        if throttle.blocked(ip, body.username):
            raise HTTPException(429, "尝试次数过多，请 15 分钟后再试")
        user = auth.authenticate(db(), body.username, body.password)
        if not user:
            throttle.fail(ip, body.username)
            raise HTTPException(401, "用户名或密码不正确")
        throttle.reset(ip, body.username)
        token = auth.issue_token(db(), user["id"], body.device_label, settings.token_days)
        return {"token": token, "user": {"username": user["username"]}}

    @app.post("/api/auth/signup")
    def signup(body: SignupRequest, request: Request) -> dict:
        if not settings.allow_signup:
            raise HTTPException(403, "此服务器未开放注册，请联系管理员创建账号")
        try:
            user_id = auth.create_user(db(), body.username, body.password)
        except ValueError as err:
            raise HTTPException(400, str(err)) from None
        token = auth.issue_token(db(), user_id, body.device_label, settings.token_days)
        return {"token": token, "user": {"username": auth.validate_username(body.username)}}

    @app.post("/api/auth/logout")
    def logout(user: dict = Depends(current_user)) -> Response:
        auth.revoke_token(db(), user["token_id"])
        return Response(status_code=204)

    @app.get("/api/me")
    def me(user: dict = Depends(current_user)) -> dict:
        return {"username": user["username"], "records": sync.stats(db(), user["id"])}

    # --- sync -------------------------------------------------------------------------

    @app.post("/api/sync/push")
    def push(body: PushRequest, user: dict = Depends(current_user)) -> dict:
        try:
            return sync.push(db(), user["id"], body.device_id, body.changes)
        except sync.SyncValidationError as err:
            raise HTTPException(400, str(err)) from None

    @app.get("/api/sync/pull")
    def pull(
        since: int = Query(0, ge=0),
        limit: int = Query(500, ge=1, le=sync.MAX_PULL),
        user: dict = Depends(current_user),
    ) -> dict:
        return sync.pull(db(), user["id"], since, limit)

    @app.delete("/api/sync/data")
    def delete_data(confirm: str = Query(""), user: dict = Depends(current_user)) -> Response:
        if confirm != user["username"]:
            raise HTTPException(400, "请在 confirm 参数中填写用户名以确认删除")
        sync.delete_all(db(), user["id"])
        return Response(status_code=204)

    # --- dictionary --------------------------------------------------------------------

    @app.get("/api/dict/info")
    def dict_info() -> dict:
        d: Dictionary = state["dictionary"]
        return {"package": d.info(), "packages": d.packages()}

    @app.get("/api/dict/entries")
    def dict_entries(k: list[str] = Query(default=[])) -> dict:
        if len(k) > 20 or any(len(x) > 120 for x in k):
            raise HTTPException(400, "too many or too long keys")
        return state["dictionary"].raw(k)

    @app.get("/api/dict/packages/{filename}")
    def dict_package(filename: str) -> FileResponse:
        path = state["dictionary"].package_path(filename)
        if not path:
            raise HTTPException(404, "没有这个词典包")
        return FileResponse(path, media_type="application/gzip", filename=filename)

    # --- hosted web app -------------------------------------------------------------------

    web_root = settings.web_root.resolve()

    @app.get("/")
    def index() -> FileResponse:
        # Landing page (project introduction) with the entry into the learning center.
        return FileResponse(web_root / "index.html", media_type="text/html; charset=utf-8")

    @app.get("/{path:path}")
    def static(path: str):
        parts = Path(path).parts
        allowed = (len(parts) == 1 and parts[0] in WEB_FILES) or (len(parts) > 1 and parts[0] in WEB_DIRS)
        target = (web_root / path).resolve()
        if not allowed or not target.is_relative_to(web_root) or not target.is_file():
            return JSONResponse({"detail": "Not found"}, status_code=404)
        return FileResponse(target, headers={"Cache-Control": "no-cache"})

    return app


app = create_app()
