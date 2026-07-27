"""MiniOp Backend API."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers.processing import router as processing_router

app = FastAPI(title="MiniOp API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "https://*.vercel.app"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(processing_router)


@app.get("/")
async def root():
    return {"message": "MiniOp API", "version": "0.2.0"}


@app.get("/health")
async def health():
    return {"status": "healthy"}
