"""Unified Provider System - Minimal"""
import os
from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import httpx

PENTARACT_URL = os.getenv("PENTARACT_URL", "https://pentaract-f4ga.onrender.com")
ADMIN_API_KEY = os.getenv("ADMIN_API_KEY", "admin-sk-1234567890")

app = FastAPI(title="Unified Provider System", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

providers_db = {}
api_keys_db = {}
usage_logs = []

class ModelProvider(BaseModel):
    name: str
    base_url: str
    api_key: str
    models: list

class ApiKeyRequest(BaseModel):
    name: str
    quota: int = 1000000

class ChatRequest(BaseModel):
    model: str
    messages: list
    stream: bool = False
    max_tokens: int = None
    temperature: float = None

def verify_api_key(authorization: str = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing API key")
    raw_key = authorization.replace("Bearer ", "")
    if raw_key == ADMIN_API_KEY:
        return {"user_id": "admin", "name": "Admin", "quota": float("inf"), "used": 0}
    import hashlib
    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
    if key_hash in api_keys_db:
        return api_keys_db[key_hash]
    raise HTTPException(status_code=403, detail="Invalid API key")

@app.get("/")
def root():
    return {"service": "Unified Provider System", "version": "1.0.0"}

@app.get("/health")
def health():
    return {"status": "ok", "providers": len(providers_db), "keys": len(api_keys_db)}

@app.post("/v1/keys")
def create_api_key(req: ApiKeyRequest, user=Depends(verify_api_key)):
    import uuid, hashlib
    raw_key = f"sk-{uuid.uuid4().hex}"
    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
    user_id = f"user_{uuid.uuid4().hex[:8]}"
    api_keys_db[key_hash] = {"user_id": user_id, "name": req.name, "quota": req.quota, "used": 0}
    return {"api_key": raw_key, "user_id": user_id, "name": req.name, "quota": req.quota}

@app.get("/v1/keys")
def list_api_keys(user=Depends(verify_api_key)):
    return {"keys": [{"name": v["name"], "quota": v["quota"], "used": v["used"]} for v in api_keys_db.values()]}

@app.get("/v1/models")
def list_models(user=Depends(verify_api_key)):
    models = []
    for pid, p in providers_db.items():
        for m in p["models"]:
            models.append({"id": m, "object": "model", "owned_by": p["name"]})
    return {"object": "list", "data": models}

@app.post("/v1/chat/completions")
async def chat_completion(req: ChatRequest, user=Depends(verify_api_key)):
    provider = None
    for pid, p in providers_db.items():
        if req.model in p["models"]:
            provider = p
            break
    if not provider:
        raise HTTPException(status_code=404, detail=f"Model {req.model} not found")
    if user["used"] >= user["quota"]:
        raise HTTPException(status_code=429, detail="Quota exhausted")
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            payload = {"model": req.model, "messages": req.messages, "stream": req.stream}
            if req.max_tokens: payload["max_tokens"] = req.max_tokens
            if req.temperature: payload["temperature"] = req.temperature
            resp = await client.post(
                f"{provider['base_url']}/chat/completions",
                json=payload,
                headers={"Authorization": f"Bearer {provider['api_key']}"}
            )
            return resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

@app.post("/v1/providers")
def add_provider(provider: ModelProvider, user=Depends(verify_api_key)):
    import uuid
    pid = f"prov_{uuid.uuid4().hex[:8]}"
    providers_db[pid] = provider.model_dump()
    return {"id": pid, "name": provider.name, "models": provider.models}

@app.get("/v1/providers")
def list_providers(user=Depends(verify_api_key)):
    return {"providers": providers_db}

@app.delete("/v1/providers/{provider_id}")
def delete_provider(provider_id: str, user=Depends(verify_api_key)):
    if provider_id in providers_db:
        del providers_db[provider_id]
        return {"status": "deleted"}
    raise HTTPException(status_code=404, detail="Provider not found")

@app.get("/v1/usage")
def get_usage(user=Depends(verify_api_key)):
    return {"quota": user["quota"], "remaining": user["quota"] - user["used"]}

@app.get("/v1/stats")
def get_stats(user=Depends(verify_api_key)):
    return {"users": len(api_keys_db), "providers": len(providers_db), "requests": len(usage_logs)}
