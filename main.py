import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.chat import router as chat_router


app = FastAPI(title="AI Context Layer API")


# ---------------------------------------------------------
# CORS
# ---------------------------------------------------------
# The frontend origin must be allowed here.
#
# Example:
# ALLOW_ORIGINS=http://localhost:5173,https://cenario-cg-xmvw.vercel.app
#
# Keep the backend URL OUT of this list unless the backend
# itself is also being used as a browser frontend.
# ---------------------------------------------------------

allow_origins_raw = os.getenv(
    "ALLOW_ORIGINS",
    "http://localhost:5173,https://cenario-cg-xmvw.vercel.app",
)

allow_origins = [
    origin.strip()
    for origin in allow_origins_raw.split(",")
    if origin.strip()
]


app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------
# API routes
# ---------------------------------------------------------

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

