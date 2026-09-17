import os

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.chat import router as chat_router

load_dotenv()

app = FastAPI(title="AI Context Layer API")


allowed_origins = [
    origin.strip()
    for origin in os.getenv("ALLOW_ORIGINS", "").split(",")
    if origin.strip()
]


app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(
    chat_router,
    prefix="/api"
)


@app.get("/")
def root():
    return {
        "status": "ok",
        "message": "Backend is running"
    }


@app.get("/api/health")
def health():
    return {
        "status": "healthy"
    }