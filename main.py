from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.chat import router as chat_router


app = FastAPI(title="AI Context Layer API")


app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "https://cenario-cg.vercel.app"],
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
