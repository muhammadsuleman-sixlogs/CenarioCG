import base64
import hashlib
import hmac
import json
import os
import time

from dotenv import load_dotenv
from fastapi import HTTPException, Request, Response, status


load_dotenv()


SESSION_COOKIE_NAME = "cenariocg_session"
SESSION_MAX_AGE = 60 * 60 * 8


def _get_auth_config():
    username = os.getenv("ADMIN_USERNAME")
    password = os.getenv("ADMIN_PASSWORD")
    secret = os.getenv("AUTH_SECRET")

    if not username or not password or not secret:
        raise RuntimeError(
            "ADMIN_USERNAME, ADMIN_PASSWORD, and AUTH_SECRET "
            "must be configured."
        )

    return username, password, secret


def _sign_payload(payload: str, secret: str) -> str:
    return hmac.new(
        secret.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def create_session(username: str) -> str:
    _, _, secret = _get_auth_config()

    payload_data = {
        "username": username,
        "expires_at": int(time.time()) + SESSION_MAX_AGE,
    }

    payload = base64.urlsafe_b64encode(
        json.dumps(
            payload_data,
            separators=(",", ":"),
        ).encode("utf-8")
    ).decode("utf-8")

    signature = _sign_payload(
        payload,
        secret,
    )

    return f"{payload}.{signature}"


def validate_session(session: str | None) -> bool:
    if not session:
        return False

    try:
        payload, signature = session.rsplit(".", 1)
    except ValueError:
        return False

    try:
        _, _, secret = _get_auth_config()

        expected_signature = _sign_payload(
            payload,
            secret,
        )

        if not hmac.compare_digest(
            signature,
            expected_signature,
        ):
            return False

        decoded = base64.urlsafe_b64decode(
            payload.encode("utf-8")
        )

        data = json.loads(decoded)

        expires_at = int(
            data.get(
                "expires_at",
                0,
            )
        )

        if expires_at <= int(time.time()):
            return False

        return True

    except Exception:
        return False


def get_session_from_request(
    request: Request,
) -> str | None:
    return request.cookies.get(
        SESSION_COOKIE_NAME
    )


def authenticate_request(request: Request):
    session = get_session_from_request(request)

    if not validate_session(session):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required.",
        )


def login_user(
    username: str,
    password: str,
    response: Response,
):
    configured_username, configured_password, _ = (
        _get_auth_config()
    )

    valid_username = hmac.compare_digest(
        username,
        configured_username,
    )

    valid_password = hmac.compare_digest(
        password,
        configured_password,
    )

    if not valid_username or not valid_password:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password.",
        )

    session = create_session(username)

    cookie_secure = (
        os.getenv(
            "COOKIE_SECURE",
            "true",
        ).strip().lower()
        == "true"
    )

    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=session,
        max_age=SESSION_MAX_AGE,
        httponly=True,
        secure=cookie_secure,
        samesite="none",
        path="/",
    )


def logout_user(response: Response):
    cookie_secure = (
        os.getenv("COOKIE_SECURE", "true").strip().lower() == "true"
    )

    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path="/",
        secure=cookie_secure,
        httponly=True,
        samesite="none",
    )