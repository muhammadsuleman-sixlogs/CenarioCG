import os
import pytest
from fastapi.testclient import TestClient

from main import app


@pytest.fixture
def client():
    return TestClient(app)


def test_auth_flow_with_token(client):
    admin_user = os.getenv("ADMIN_USERNAME", "admin")
    admin_pass = os.getenv("ADMIN_PASSWORD", "sixlogs@CE2026")

    # 1. Unauthenticated request to /api/auth/me should fail
    resp = client.get("/api/auth/me")
    assert resp.status_code == 401

    # 2. Login with wrong credentials should fail
    resp = client.post("/api/auth/login", json={"username": "wrong", "password": "bad"})
    assert resp.status_code == 401

    # 3. Login with correct credentials should succeed and return token
    resp = client.post("/api/auth/login", json={"username": admin_user, "password": admin_pass})
    assert resp.status_code == 200
    data = resp.json()
    assert data.get("authenticated") is True
    token = data.get("token")
    assert token and isinstance(token, str)

    # 4. Request /api/auth/me with Bearer token should succeed
    resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert resp.json().get("authenticated") is True

    # 5. Request /api/auth/me with invalid token should fail
    resp = client.get("/api/auth/me", headers={"Authorization": "Bearer invalid.token"})
    assert resp.status_code == 401
