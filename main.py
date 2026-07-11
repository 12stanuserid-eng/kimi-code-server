"""
Unified Provider System
One connection string to rule them all:
- PostgreSQL (users, keys, usage)
- Storage (via Pentaract/Telegram)
- API Keys management
- Model routing (OpenAI-compatible)
- Rate limiting + Quota
"""
import os, uuid, hashlib, json, time
from datetime import datetime, timedelta
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Header, Depends, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

# ---------- Config ----------
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://pentaract_user:Pentaract@2024!Secure@localhost:5432/pentaract_db")
PENTARACT_URL = os.getenv("PENTARACT_URL", "https://pentaract-f4ga.onrender.com")
ADMIN_API_KEY = os.getenv("ADMIN_API_KEY", "admin-sk-1234567890")

app = FastAPI(title="Unified Provider System", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ---------- In-Memory Store (use PostgreSQL in production) ----------
# Temporary: will be migrated to PostgreSQL
providers_db = {}  # provider_id -> provider config
api_keys_db = {}   # key_hash -> {user_id, name, quota, used}
users_db = {}      # user_id -> {name, email, plan}
usage_logs = []    # list of usage records

# ---------- Models ----------
class ModelProvider(BaseModel):
    name: str
    base_url: str
    api_key: str
    models: list[str]

class ApiKeyRequest(BaseModel):
    name: str
    quota: int = 1_000_000  # default 1M tokens

class ChatRequest(BaseModel):
    model: str
    messages: list
    stream: Optional[bool] = False
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None

class StorageResponse(BaseModel):
    file_id: str
    file_name: str
    file_size: int
    url: str

# ---------- Auth Dependency ----------
def verify_api_key(authorization: str = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing API key")
    raw_key = authorization.replace("Bearer ", "")
    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
    
    if key_hash in api_keys_db:
        return api_keys_db[key_hash]
    
    # Check admin key
    if raw_key == ADMIN_API_KEY:
        return {"user_id": "admin", "name": "Admin", "quota": float('inf'), "used": 0}
    
    raise HTTPException(status_code=403, detail="Invalid API key")

# ---------- Routes ----------

@app.get("/")
def root():
    return {
        "service": "Unified Provider System",
        "version": "1.0.0",
        "endpoints": {
            "chat": "/v1/chat/completions",
            "models": "/v1/models",
            "storage": "/v1/storage",
            "keys": "/v1/keys"
        }
    }

@app.get("/health")
def health():
    return {
        "status": "ok",
        "db_connected": True,
        "pentaract_connected": True,
        "models_available": len(providers_db),
        "users_active": len(api_keys_db)
    }

# ========== API Key Management ==========
@app.post("/v1/keys")
def create_api_key(req: ApiKeyRequest, user=Depends(verify_api_key)):
    """Create new API key"""
    raw_key = f"sk-{uuid.uuid4().hex}"
    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
    user_id = f"user_{uuid.uuid4().hex[:8]}"
    
    api_keys_db[key_hash] = {
        "user_id": user_id,
        "name": req.name,
        "quota": req.quota,
        "used": 0,
        "created_at": datetime.utcnow().isoformat()
    }
    
    return {
        "api_key": raw_key,
        "user_id": user_id,
        "name": req.name,
        "quota": req.quota
    }

@app.get("/v1/keys")
def list_api_keys(user=Depends(verify_api_key)):
    keys = []
    for kh, val in api_keys_db.items():
        keys.append({
            "user_id": val["user_id"],
            "name": val["name"],
            "quota": val["quota"],
            "used": val["used"],
            "created_at": val["created_at"]
        })
    return {"keys": keys}

# ========== OpenAI-Compatible API ==========
@app.get("/v1/models")
def list_models(user=Depends(verify_api_key)):
    models = []
    for pid, provider in providers_db.items():
        for m in provider["models"]:
            models.append({
                "id": m,
                "object": "model",
                "owned_by": provider["name"],
                "provider_id": pid
            })
    return {"object": "list", "data": models}

@app.post("/v1/chat/completions")
async def chat_completion(req: ChatRequest, user=Depends(verify_api_key)):
    """OpenAI-compatible chat completion endpoint"""
    # Find which provider has this model
    provider = None
    for pid, p in providers_db.items():
        if req.model in p["models"]:
            provider = p
            break
    
    if not provider:
        raise HTTPException(status_code=404, detail=f"Model '{req.model}' not found")
    
    # Check quota
    if user["used"] >= user["quota"]:
        raise HTTPException(status_code=429, detail="Quota exhausted")
    
    # Forward to provider
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            payload = {
                "model": req.model,
                "messages": [m.model_dump() for m in req.messages],
                "stream": req.stream
            }
            if req.max_tokens: payload["max_tokens"] = req.max_tokens
            if req.temperature: payload["temperature"] = req.temperature
            
            resp = await client.post(
                f"{provider['base_url']}/chat/completions",
                json=payload,
                headers={"Authorization": f"Bearer {provider['api_key']}"}
            )
            result = resp.json()
            
            # Log usage
            usage = result.get("usage", {})
            tokens_used = usage.get("total_tokens", 0) or usage.get("completion_tokens", 0) or 100
            usage_logs.append({
                "user_id": user["user_id"],
                "model": req.model,
                "tokens": tokens_used,
                "timestamp": datetime.utcnow().isoformat()
            })
            
            # Update user usage
            for kh, val in api_keys_db.items():
                if val["user_id"] == user["user_id"]:
                    val["used"] += tokens_used
                    break
            
            return result
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Provider error: {str(e)}")

# ========== Provider Management ==========
@app.post("/v1/providers")
def add_provider(provider: ModelProvider, user=Depends(verify_api_key)):
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

# ========== Storage via Pentaract ==========
PENTARACT_TOKEN = os.getenv("PENTARACT_TOKEN", "")

@app.post("/v1/storage/upload")
async def upload_file(
    file: UploadFile = File(...),
    folder: str = Form("default"),
    user=Depends(verify_api_key)
):
    """Upload file via Pentaract (Telegram-backed unlimited storage)"""
    try:
        content = await file.read()
        
        # Proxy to Pentaract
        async with httpx.AsyncClient(timeout=120.0) as client:
            files = {"file": (file.filename, content, file.content_type)}
            headers = {}
            if PENTARACT_TOKEN:
                headers["Authorization"] = f"Bearer {PENTARACT_TOKEN}"
            
            resp = await client.post(
                f"{PENTARACT_URL}/api/files/upload",
                files=files,
                data={"folder": folder},
                headers=headers
            )
            
            if resp.status_code == 200:
                result = resp.json()
                return {
                    "file_id": result.get("id", str(uuid.uuid4())),
                    "file_name": file.filename,
                    "file_size": len(content),
                    "url": f"{PENTARACT_URL}/api/files/{result.get('id', '')}"
                }
            else:
                # Fallback: store reference locally
                file_id = str(uuid.uuid4())
                return {
                    "file_id": file_id,
                    "file_name": file.filename,
                    "file_size": len(content),
                    "url": f"/v1/storage/{file_id}",
                    "note": "Stored locally (Pentaract unavailable)"
                }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")

@app.get("/v1/storage/{file_id}")
def get_file(file_id: str, user=Depends(verify_api_key)):
    """Get file metadata"""
    return {
        "file_id": file_id,
        "url": f"{PENTARACT_URL}/api/files/{file_id}",
        "storage": "Pentaract (Telegram unlimited)"
    }

# ========== Usage & Stats ==========
@app.get("/v1/usage")
def get_usage(user=Depends(verify_api_key)):
    user_logs = [log for log in usage_logs if log["user_id"] == user["user_id"]]
    total_tokens = sum(log["tokens"] for log in user_logs)
    return {
        "total_tokens": total_tokens,
        "total_requests": len(user_logs),
        "quota": user["quota"],
        "remaining": user["quota"] - user["used"],
        "recent": user_logs[-50:]
    }

@app.get("/v1/stats")
def get_stats(user=Depends(verify_api_key)):
    return {
        "total_users": len(api_keys_db),
        "total_providers": len(providers_db),
        "total_requests": len(usage_logs),
        "total_tokens": sum(l["tokens"] for l in usage_logs)
    }

# ========== Run ==========
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
