import gzip
import hashlib
import json

import pytest
from fastapi.testclient import TestClient

from localingo_server import auth
from localingo_server.app import create_app
from localingo_server.config import Settings

PASSWORD = "correct horse battery"


def write_package(dist, variant="base"):
    manifest = {"type": "package", "schema_version": 1, "package_id": f"ecdict-{variant}", "source_id": "ecdict",
                "source_version": "abc123", "variant": variant, "license": "MIT", "license_text": "MIT…", "entries": 2, "forms": 1}
    lines = [manifest,
             {"type": "entry", "k": "bank", "w": "bank", "en": [["n", "a financial institution"]], "zh": [["n", "银行"]]},
             {"type": "entry", "k": "ai", "w": "AI", "zh": [["", "[计] 人工智能"]]},
             {"type": "form", "k": "banked", "of": [["bank", "d"]]}]
    data = gzip.compress("\n".join(json.dumps(l, ensure_ascii=False) for l in lines).encode())
    name = f"localingo-dict-ecdict-{variant}-abc123"
    (dist / f"{name}.jsonl.gz").write_bytes(data)
    out = {k: v for k, v in manifest.items() if k != "type"}
    out.update(file=f"{name}.jsonl.gz", sha256=hashlib.sha256(data).hexdigest(), bytes=len(data))
    (dist / f"{name}.json").write_text(json.dumps(out))


@pytest.fixture
def settings(tmp_path):
    dist = tmp_path / "dist"
    dist.mkdir()
    write_package(dist)
    web = tmp_path / "web"
    (web / "learn").mkdir(parents=True)
    (web / "learn.html").write_text("<!doctype html><title>Learn</title>")
    (web / "index.html").write_text("<!doctype html><title>LocaLingo</title><a href='/learn.html'>进入我的个人空间</a>")
    (web / "index.css").write_text("body{}")
    (web / "learn" / "learn.js").write_text("console.log(1)")
    (web / "manifest.json").write_text("{}")
    (tmp_path / "secret.txt").write_text("nope")
    return Settings(data_dir=tmp_path / "data", web_root=web, dict_dir=dist, dict_variant="base",
                    allow_signup=False, admin_user="alice", admin_password=PASSWORD, cors_origins=[], token_days=30)


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings)) as c:
        yield c


def login(client, user="alice", password=PASSWORD):
    r = client.post("/api/auth/login", json={"username": user, "password": password, "device_label": "test"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_password_hashing_roundtrip():
    h = auth.hash_password("a long password!")
    assert auth.verify_password("a long password!", h)
    assert not auth.verify_password("wrong password!!", h)
    assert not auth.verify_password("x", "garbage")


def test_health_is_public_and_api_requires_login(client):
    assert client.get("/api/health").json()["dictionary"] is True
    assert client.get("/api/me").status_code == 401
    assert client.get("/api/me", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get("/api/sync/pull").status_code == 401


def test_login_logout_and_throttle(client):
    headers = login(client)
    assert client.get("/api/me", headers=headers).json()["username"] == "alice"
    assert client.post("/api/auth/logout", headers=headers).status_code == 204
    assert client.get("/api/me", headers=headers).status_code == 401
    for _ in range(8):
        assert client.post("/api/auth/login", json={"username": "alice", "password": "wrong-password"}).status_code == 401
    r = client.post("/api/auth/login", json={"username": "alice", "password": PASSWORD})
    assert r.status_code == 429


def test_signup_disabled_by_default(client):
    r = client.post("/api/auth/signup", json={"username": "bob", "password": PASSWORD})
    assert r.status_code == 403


def test_signup_when_enabled(settings):
    settings.allow_signup = True
    with TestClient(create_app(settings)) as c:
        assert c.post("/api/auth/signup", json={"username": "Bob", "password": "short"}).status_code == 400
        r = c.post("/api/auth/signup", json={"username": "Bob", "password": PASSWORD})
        assert r.status_code == 200
        assert r.json()["user"]["username"] == "bob"
        assert c.post("/api/auth/signup", json={"username": "bob", "password": PASSWORD}).status_code == 400


def rec(id_, updated, device="d1", **extra):
    return {"id": id_, "updated_at": updated, "device_id": device, **extra}


def test_push_pull_last_writer_wins_and_paging(client):
    h = login(client)
    r = client.post("/api/sync/push", headers=h, json={"device_id": "d1", "changes": {
        "items": [rec("i1", 100, note="first"), rec("i2", 100)], "events": [rec("e1", 100, card_id="c1", rating=3)]}})
    assert r.json()["accepted"] == 3
    # Older write is ignored; newer wins; equal timestamps break ties by device id.
    client.post("/api/sync/push", headers=h, json={"device_id": "d2", "changes": {"items": [rec("i1", 50, "d2", note="old")]}})
    client.post("/api/sync/push", headers=h, json={"device_id": "d2", "changes": {"items": [rec("i2", 100, "d0", note="tie-loses")]}})
    client.post("/api/sync/push", headers=h, json={"device_id": "d2", "changes": {"items": [rec("i1", 200, "d2", note="new")]}})
    data = client.get("/api/sync/pull?since=0&limit=1000", headers=h).json()
    items = {i["id"]: i for i in data["changes"]["items"]}
    assert items["i1"]["note"] == "new"
    assert "note" not in items["i2"]
    assert data["more"] is False

    page = client.get("/api/sync/pull?since=0&limit=2", headers=h).json()
    assert page["more"] is True
    rest = client.get(f"/api/sync/pull?since={page['cursor']}&limit=2", headers=h).json()
    ids = [r["id"] for rows in [*page["changes"].values(), *rest["changes"].values()] for r in rows]
    assert sorted(ids) == ["e1", "i1", "i2"]

    # A cursor ahead of the server (e.g. server restored) starts over.
    reset = client.get("/api/sync/pull?since=999", headers=h).json()
    assert reset["reset"] is True and reset["cursor"] == 0 and reset["more"] is True


def test_users_are_isolated(settings):
    settings.allow_signup = True
    with TestClient(create_app(settings)) as c:
        a = login(c)
        c.post("/api/sync/push", headers=a, json={"device_id": "d", "changes": {"items": [rec("i1", 1)]}})
        b_token = c.post("/api/auth/signup", json={"username": "bob", "password": PASSWORD}).json()["token"]
        b = {"Authorization": f"Bearer {b_token}"}
        assert c.get("/api/sync/pull", headers=b).json()["changes"] == {}


@pytest.mark.parametrize("changes", [
    {"unknown": [rec("x", 1)]},
    {"items": "nope"},
    {"items": [{"id": "", "updated_at": 1}]},
    {"items": [{"id": "x", "updated_at": "1"}]},
    {"items": [{"id": "x", "updated_at": True}]},
    {"items": [rec("x", 1, blob="a" * 70_000)]},
    {"items": [rec(f"x{i}", 1) for i in range(1001)]},
])
def test_push_validation(client, changes):
    h = login(client)
    r = client.post("/api/sync/push", headers=h, json={"device_id": "d", "changes": changes})
    assert r.status_code == 400


def test_delete_all_data_requires_confirmation(client):
    h = login(client)
    client.post("/api/sync/push", headers=h, json={"device_id": "d", "changes": {"items": [rec("i1", 1)]}})
    assert client.delete("/api/sync/data", headers=h).status_code == 400
    assert client.delete("/api/sync/data?confirm=alice", headers=h).status_code == 204
    assert client.get("/api/me", headers=h).json()["records"] == {}


def test_dictionary_api(client):
    h = login(client)
    info = client.get("/api/dict/info", headers=h).json()
    assert info["package"]["source_id"] == "ecdict"
    assert "license_text" not in info["packages"][0]
    data = client.get("/api/dict/entries?k=bank&k=ai&k=banked&k=missing", headers=h).json()
    assert data["entries"]["bank"][0]["w"] == "bank"
    assert data["entries"]["ai"][0]["w"] == "AI"
    assert data["forms"]["banked"]["of"] == [["bank", "d"]]
    assert "missing" not in data["entries"]
    assert client.get("/api/dict/entries?" + "&".join(f"k=w{i}" for i in range(21)), headers=h).status_code == 400
    pkg = info["packages"][0]["file"]
    assert client.get(f"/api/dict/packages/{pkg}", headers=h).status_code == 200
    assert client.get("/api/dict/packages/../secret.txt", headers=h).status_code == 404


def test_web_app_files_only(client):
    r = client.get("/")
    assert r.status_code == 200 and "LocaLingo" in r.text and "进入我的个人空间" in r.text
    assert "default-src 'self'" in r.headers["content-security-policy"]
    assert client.get("/index.css").status_code == 200
    assert client.get("/learn.html").status_code == 200
    assert client.get("/learn/learn.js").status_code == 200
    assert client.get("/manifest.json").status_code == 404
    assert client.get("/learn/../../secret.txt").status_code == 404
    assert client.get("/%2e%2e/secret.txt").status_code == 404


def test_cors_allows_extensions_only(client):
    pre = {"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"}
    ext = "chrome-extension://" + "a" * 32
    ok = client.options("/api/sync/push", headers={"Origin": ext, **pre})
    assert ok.headers.get("access-control-allow-origin") == ext
    bad = client.options("/api/sync/push", headers={"Origin": "https://evil.example", **pre})
    assert "access-control-allow-origin" not in bad.headers
