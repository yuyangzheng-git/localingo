import pytest
from fastapi.testclient import TestClient

from web_translator import server


class FakeTranslator:
    model_id = "fake-model"
    loaded = True

    def translate_batch(self, texts):
        return [f"zh:{t}" for t in texts]


EXT = {"Origin": "chrome-extension://" + "a" * 32}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(server, "_translator", FakeTranslator())
    return TestClient(server.app, base_url="http://127.0.0.1:8765")


def test_translate_from_extension_needs_no_token(client):
    resp = client.post("/translate", json={"texts": ["a", "b"]}, headers=EXT)
    assert resp.status_code == 200
    assert resp.json() == {"translations": ["zh:a", "zh:b"]}


@pytest.mark.parametrize("origin", [None, "https://evil.example", "http://127.0.0.1:8765", "null", "chrome-extension://short"])
def test_translate_rejects_other_origins(client, origin):
    headers = {"Origin": origin} if origin else {}
    assert client.post("/translate", json={"texts": ["hi"]}, headers=headers).status_code == 403


def test_translate_rejects_dns_rebinding_host(client):
    resp = client.post("/translate", json={"texts": ["hi"]}, headers={**EXT, "Host": "evil.example:8765"})
    assert resp.status_code == 403


def test_translate_accepts_localhost_host(client):
    assert client.post("/translate", json={"texts": ["hi"]}, headers={**EXT, "Host": "localhost:8765"}).status_code == 200


def test_health_is_open(client):
    data = client.get("/health").json()
    assert data["status"] == "ok" and data["authorized"] is True


def test_request_limits(client):
    too_many = client.post("/translate", json={"texts": ["x"] * (server.MAX_TEXTS + 1)}, headers=EXT)
    assert too_many.status_code == 422
    too_long = client.post("/translate", json={"texts": ["x" * (server.MAX_TEXT_CHARS + 1)]}, headers=EXT)
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
