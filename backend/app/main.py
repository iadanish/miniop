from fastapi import FastAPI

app = FastAPI(title="MiniOp API", version="0.1.0")

@app.get("/")
async def root():
    return {"message": "MiniOp API"}

@app.get("/health")
async def health():
    return {"status": "healthy"}
