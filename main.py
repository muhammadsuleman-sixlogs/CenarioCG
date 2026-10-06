import os

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from api.chat import router as chat_router
from auth.authentication import (
    authenticate_request,
    login_user,
    logout_user,
    set_session_cookie,
)


load_dotenv()


app = FastAPI(
    title="AI Context Layer API"
)


allow_origins_raw = os.getenv(
    "ALLOW_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173,https://cenario-cg-xmvw.vercel.app",
)

allow_origins = [
    origin.strip()
    for origin in allow_origins_raw.split(",")
    if origin.strip()
]
if "http://localhost:5173" in allow_origins and "http://127.0.0.1:5173" not in allow_origins:
    allow_origins.append("http://127.0.0.1:5173")


app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


PUBLIC_PATHS = {
    "/",
    "/api/health",
    "/api/auth/login",
    "/api/auth/logout",
}


@app.middleware("http")
async def authentication_middleware(
    request: Request,
    call_next,
):
    if request.method == "OPTIONS":
        return await call_next(request)

    if request.url.path in PUBLIC_PATHS:
        return await call_next(request)

    if request.url.path.startswith("/api/"):
        try:
            authenticate_request(request)
        except Exception as exc:
            if hasattr(exc, "status_code"):
                return JSONResponse(
                    status_code=exc.status_code,
                    content={
                        "detail": exc.detail
                    },
                )

            return JSONResponse(
                status_code=401,
                content={
                    "detail": "Authentication required."
                },
            )

    return await call_next(request)


@app.post("/api/auth/login")
async def login(request: Request):
    body = await request.json()

    username = str(
        body.get(
            "username",
            "",
        )
    )

    password = str(
        body.get(
            "password",
            "",
        )
    )

    session = login_user(
        username=username,
        password=password,
    )

    response = JSONResponse(
        content={
            "authenticated": True,
            "token": session,
        }
    )

    set_session_cookie(
        response=response,
        session=session,
    )

    return response


@app.get("/api/auth/me")
async def auth_me():
    return {
        "authenticated": True,
    }


@app.post("/api/auth/logout")
async def logout():
    response = JSONResponse(
        content={
            "authenticated": False,
        }
    )

    logout_user(response)

    return response


app.include_router(
    chat_router,
    prefix="/api",
)


@app.get("/")
def root():
    return {
        "status": "ok",
        "message": "Backend is running",
    }


@app.get("/api/health")
def health():
    return {
        "status": "healthy",
    }