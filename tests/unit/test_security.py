"""I16 — no route is reachable without the session token. Acceptance rows 25 and 26."""

import pytest
from fastapi.testclient import TestClient

from assignment_helper.app import ServerConfig, choose_port, create_app
from assignment_helper.security import SessionToken


@pytest.fixture
def client_and_token():
    port = choose_port()
    token = SessionToken()
    app = create_app(ServerConfig(port=port), token)
    return TestClient(app, base_url=f"http://127.0.0.1:{port}"), token


def test_api_requires_a_token(client_and_token):
    client, _ = client_and_token
    assert client.get("/api/status").status_code == 403


def test_wrong_token_is_rejected(client_and_token):
    client, _ = client_and_token
    assert client.get("/api/status", headers={"x-ah-token": "nope"}).status_code == 403


def test_correct_token_is_accepted(client_and_token):
    client, token = client_and_token
    assert client.get("/api/status", headers={"x-ah-token": token.value}).status_code == 200


def test_dns_rebinding_is_rejected_on_the_host_header(client_and_token):
    client, token = client_and_token
    r = client.get("/api/status", headers={"x-ah-token": token.value, "host": "attacker.example"})
    assert r.status_code == 403
    assert r.json()["code"] == "auth.host-not-allowed"


def test_cross_site_state_change_is_rejected(client_and_token):
    client, token = client_and_token
    r = client.post(
        "/api/document/health",
        headers={"x-ah-token": token.value, "sec-fetch-site": "cross-site"},
    )
    assert r.status_code == 403


def test_token_never_appears_in_a_repr_or_a_log_line(client_and_token):
    _, token = client_and_token
    assert token.value not in repr(token)
    assert token.value not in str(token)


def test_token_is_not_in_the_status_body(client_and_token):
    client, token = client_and_token
    body = client.get("/api/status", headers={"x-ah-token": token.value}).text
    assert token.value not in body
