import pytest
from fastapi.testclient import TestClient

from web_translator import server


class FakeTranslator:
    model_id = "fake-model"
    loaded = True

    def translate_batch(self, texts):
        return [f"zh:{t}" for t in texts]


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.delenv("WEB_TRANSLATOR_TOKEN", raising=False)
    monkeypatch.setattr(server, "TOKEN_FILE", tmp_path / "token")
    monkeypatch.setattr(server, "_cached_token", None)
    monkeypatch.setattr(server, "_translator", FakeTranslator())
    return TestClient(server.app)


def test_token_is_random_and_persisted(client):
    token = server._token()
    assert token != "web-translator-local-token" and len(token) >= 24
    assert server.TOKEN_FILE.read_text().strip() == token
    assert server.TOKEN_FILE.stat().st_mode & 0o777 == 0o600


def test_translate_requires_token(client):
    assert client.post("/translate", json={"texts": ["hi"]}).status_code == 401
    bad = client.post("/translate", json={"texts": ["hi"]}, headers={"X-Auth-Token": "nope"})
    assert bad.status_code == 401


def test_translate_with_token(client):
    resp = client.post("/translate", json={"texts": ["a", "b"]}, headers={"X-Auth-Token": server._token()})
    assert resp.status_code == 200
    assert resp.json() == {"translations": ["zh:a", "zh:b"]}


def test_health_reports_authorization(client):
    assert client.get("/health").json()["authorized"] is False
    assert client.get("/health", headers={"X-Auth-Token": server._token()}).json()["authorized"] is True


def test_request_limits(client):
    headers = {"X-Auth-Token": server._token()}
    too_many = client.post("/translate", json={"texts": ["x"] * (server.MAX_TEXTS + 1)}, headers=headers)
    assert too_many.status_code == 422
    too_long = client.post("/translate", json={"texts": ["x" * (server.MAX_TEXT_CHARS + 1)]}, headers=headers)
    assert too_long.status_code == 413


@pytest.mark.parametrize("origin", ["https://evil.example", "http://localhost:3000", "null"])
def test_cors_preflight_rejects_web_pages(client, origin):
    resp = client.options(
        "/translate",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-auth-token,content-type",
        },
    )
    assert "access-control-allow-origin" not in resp.headers


def test_cors_preflight_allows_extensions(client):
    origin = "chrome-extension://" + "a" * 32
    resp = client.options(
        "/translate",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-auth-token,content-type",
        },
    )
    assert resp.headers.get("access-control-allow-origin") == origin
