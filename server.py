"""Pentaract - unlimited file storage server (Telegram + Supabase REST API)"""
import os, sys, uuid, io, json, asyncio, hashlib, secrets
from datetime import datetime, timedelta, timezone

OS_ENV = os.environ

SUPABASE_URL = OS_ENV.get("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = OS_ENV.get("SUPABASE_SERVICE_KEY", "")
TELEGRAM_BOT_TOKEN = OS_ENV.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHANNEL_ID = OS_ENV.get("TELEGRAM_CHANNEL_ID", "")
PORT = int(OS_ENV.get("PORT", "10000"))
SECRET_KEY = OS_ENV.get("SECRET_KEY", "change-me-secret-key")
ACCESS_TOKEN_EXPIRE_SECS = int(OS_ENV.get("ACCESS_TOKEN_EXPIRE_IN_SECS", "3600"))
REFRESH_TOKEN_EXPIRE_DAYS = int(OS_ENV.get("REFRESH_TOKEN_EXPIRE_IN_DAYS", "30"))
SUPERUSER_EMAIL = OS_ENV.get("SUPERUSER_EMAIL", "admin@pentaract.com")
SUPERUSER_PASS = OS_ENV.get("SUPERUSER_PASS", "admin123")
TELEGRAM_API_BASE = OS_ENV.get("TELEGRAM_API_BASE_URL", "https://api.telegram.org")

missing = [k for k, v in [
    ("SUPABASE_URL", SUPABASE_URL),
    ("SUPABASE_SERVICE_KEY", SUPABASE_SERVICE_KEY),
    ("TELEGRAM_BOT_TOKEN", TELEGRAM_BOT_TOKEN),
    ("TELEGRAM_CHANNEL_ID", TELEGRAM_CHANNEL_ID),
] if not v]
if missing:
    print(f"[WARN] Missing: {', '.join(missing)}", flush=True)

from fastapi import FastAPI, HTTPException, Depends, UploadFile, File, Form, Header
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from jose import jwt

app = FastAPI(title="Pentaract")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_db_ready = False
_db_error = ""
ALGO = "HS256"

# ─── Supabase REST client ─────────────────────────────────────────────────

async def _supa(method: str, path: str, data: dict = None, params: dict = None, headers: dict = None) -> list | dict:
    """Call Supabase REST API. Returns decoded JSON."""
    import httpx
    url = f"{SUPABASE_URL}/rest/v1/{path.lstrip('/')}"
    hdrs = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }
    if method == "POST":
        hdrs["Prefer"] = "return=representation"
    if headers:
        hdrs.update(headers)
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.request(method, url, headers=hdrs, json=data, params=params)
        if r.status_code >= 400 and r.status_code not in (404, 409):
            raise HTTPException(502, f"Supabase error {r.status_code}: {r.text[:200]}")
        if r.status_code in (204, 201) or not r.text.strip():
            return [] if r.status_code == 204 else r.json() if r.text.strip() else []
        return r.json()

# ─── Password helpers (pbkdf2, no external deps) ─────────────────────────

PBKDF2_ITER = 600000

def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), PBKDF2_ITER)
    return f"{salt}:{dk.hex()}"

def verify_password(password: str, stored: str) -> bool:
    try:
        salt, dk_hex = stored.split(":", 1)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), PBKDF2_ITER)
        return dk.hex() == dk_hex
    except Exception:
        return False

# ─── Auth helpers ──────────────────────────────────────────────────────────

def make_access_token(user_id: str, email: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(seconds=ACCESS_TOKEN_EXPIRE_SECS)
    return jwt.encode({"sub": user_id, "email": email, "exp": exp, "type": "access"}, SECRET_KEY, ALGO)

def make_refresh_token(user_id: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    return jwt.encode({"sub": user_id, "exp": exp, "type": "refresh"}, SECRET_KEY, ALGO)

def verify_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGO])
    except Exception as e:
        raise HTTPException(401, detail=f"Invalid token: {e}")

async def get_user_from_header(authorization: str = Header(None)) -> dict:
    if not authorization:
        raise HTTPException(401, detail="Missing Authorization header")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(401, detail="Invalid Authorization header")
    payload = verify_token(token)
    if payload.get("type") != "access":
        raise HTTPException(401, detail="Invalid token type")
    return {"id": payload["sub"], "email": payload.get("email", "")}

# ─── Telegram helpers ──────────────────────────────────────────────────────

async def tg_upload(data: bytes, name: str) -> str:
    import httpx
    async with httpx.AsyncClient(timeout=120) as c:
        files = {"document": (name, io.BytesIO(data), "application/octet-stream")}
        r = await c.post(f"{TELEGRAM_API_BASE}/bot{TELEGRAM_BOT_TOKEN}/sendDocument",
                         data={"chat_id": TELEGRAM_CHANNEL_ID}, files=files)
        j = r.json()
        if not j.get("ok"):
            raise HTTPException(502, f"Telegram upload failed: {j.get('description', '?')}")
        return j["result"]["document"]["file_id"]

async def tg_download(file_id: str) -> bytes:
    import httpx
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.get(f"{TELEGRAM_API_BASE}/bot{TELEGRAM_BOT_TOKEN}/getFile?file_id={file_id}")
        j = r.json()
        if not j.get("ok"):
            raise HTTPException(502, f"Telegram getFile failed: {j.get('description', '?')}")
        fp = j["result"]["file_path"]
        dl = await c.get(f"{TELEGRAM_API_BASE}/file/bot{TELEGRAM_BOT_TOKEN}/{fp}")
        return dl.content

# ─── Database init ─────────────────────────────────────────────────────────

async def init_db():
    """Ensure superuser exists via Supabase REST API."""
    global _db_ready, _db_error
    try:
        # Check if superuser exists
        users = await _supa("GET", "users", params={"email": f"eq.{SUPERUSER_EMAIL}", "select": "id"})
        if not users or len(users) == 0:
            uid = str(uuid.uuid4())
            await _supa("POST", "users", {
                "id": uid,
                "email": SUPERUSER_EMAIL,
                "password_hash": hash_password(SUPERUSER_PASS),
            })
            print(f"[db] Superuser created: {SUPERUSER_EMAIL}", flush=True)
        else:
            print(f"[db] Superuser exists: {SUPERUSER_EMAIL}", flush=True)
        _db_ready = True
        print("[db] Init complete", flush=True)
    except Exception as e:
        _db_error = f"{type(e).__name__}: {str(e)[:200]}"
        print(f"[db] Init FAILED: {_db_error}", flush=True)

@app.on_event("startup")
async def startup():
    print(f"[startup] Pentaract starting on port {PORT}", flush=True)
    print(f"[startup] Supabase: {SUPABASE_URL}", flush=True)
    print(f"[startup] Telegram bot: {TELEGRAM_BOT_TOKEN[:10]}...", flush=True)
    asyncio.create_task(init_db())
    print("[startup] Server is live", flush=True)

# ─── Routes ────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {"status": "ok", "service": "pentaract", "version": "0.1.0"}

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "db_ready": _db_ready,
        "db_error": _db_error if not _db_ready else "",
        "telegram_bot": bool(TELEGRAM_BOT_TOKEN),
        "telegram_channel": bool(TELEGRAM_CHANNEL_ID),
    }

# Auth
@app.post("/api/auth/login")
async def login(email: str = Form(...), password: str = Form(...)):
    users = await _supa("GET", "users", params={"email": f"eq.{email}", "select": "id,email,password_hash"})
    if not users:
        raise HTTPException(401, detail="Invalid credentials")
    u = users[0]
    if not verify_password(password, u["password_hash"]):
        raise HTTPException(401, detail="Invalid credentials")
    return {"access_token": make_access_token(u["id"], u["email"]),
            "refresh_token": make_refresh_token(u["id"]), "token_type": "bearer"}

@app.post("/api/auth/refresh")
async def refresh(authorization: str = Header(None)):
    user = await get_user_from_header(authorization)
    users = await _supa("GET", "users", params={"id": f"eq.{user['id']}", "select": "email"})
    if not users:
        raise HTTPException(401, detail="User not found")
    return {"access_token": make_access_token(user["id"], users[0]["email"]),
            "refresh_token": make_refresh_token(user["id"]), "token_type": "bearer"}

# Users
@app.post("/api/users")
async def create_user(email: str = Form(...), password: str = Form(...)):
    existing = await _supa("GET", "users", params={"email": f"eq.{email}", "select": "id"})
    if existing:
        raise HTTPException(409, detail="Email already exists")
    uid = str(uuid.uuid4())
    await _supa("POST", "users", {"id": uid, "email": email, "password_hash": hash_password(password)})
    return {"id": uid, "email": email}

@app.get("/api/users/me")
async def me(user: dict = Depends(get_user_from_header)):
    return user

# Storages
@app.post("/api/storages")
async def create_storage(name: str = Form(...), chat_id: int = Form(...),
                         user: dict = Depends(get_user_from_header)):
    sid = str(uuid.uuid4())
    try:
        await _supa("POST", "storages", {"id": sid, "name": name, "chat_id": chat_id})
        await _supa("POST", "access", {
            "id": str(uuid.uuid4()), "user_id": user["id"], "storage_id": sid, "access_type": "a"
        })
    except HTTPException:
        raise HTTPException(400, detail="Storage creation failed")
    return {"id": sid, "name": name, "chat_id": chat_id}

@app.get("/api/storages")
async def list_storages(user: dict = Depends(get_user_from_header)):
    storages = await _supa("GET", "storages", params={"select": "id,name,chat_id",
                           "order": "name.asc"})
    # Filter by access
    result = []
    for s in storages:
        access = await _supa("GET", "access", params={
            "user_id": f"eq.{user['id']}", "storage_id": f"eq.{s['id']}", "select": "id"
        })
        if access:
            result.append(s)
    return result

@app.get("/api/storages/{sid}")
async def get_storage(sid: str, user: dict = Depends(get_user_from_header)):
    storages = await _supa("GET", "storages", params={"id": f"eq.{sid}", "select": "id,name,chat_id"})
    if not storages:
        raise HTTPException(404, detail="Storage not found")
    return storages[0]

# Files
@app.post("/api/files/{sid}/upload")
async def upload_file(sid: str, file: UploadFile = File(...), path: str = Form("/"),
                      user: dict = Depends(get_user_from_header)):
    access = await _supa("GET", "access", params={
        "user_id": f"eq.{user['id']}", "storage_id": f"eq.{sid}", "select": "access_type"
    })
    if not access or access[0].get("access_type", "") not in ("w", "a"):
        raise HTTPException(403, "No write access")

    data = await file.read()
    fname = file.filename or "unnamed"
    full_path = f"{path.rstrip('/')}/{fname}".lstrip("/")

    # Upload to Telegram (unlimited storage)
    tg_id = await tg_upload(data, fname)

    fid = str(uuid.uuid4())
    await _supa("POST", "files", {
        "id": fid, "path": full_path, "size": len(data), "storage_id": sid, "is_uploaded": True
    })
    await _supa("POST", "file_chunks", {
        "id": str(uuid.uuid4()), "file_id": fid, "telegram_file_id": tg_id, "position": 0
    })
    return {"id": fid, "path": full_path, "size": len(data), "telegram_file_id": tg_id}

@app.get("/api/files/{sid}/download/{path:path}")
async def download_file(sid: str, path: str, user: dict = Depends(get_user_from_header)):
    access = await _supa("GET", "access", params={
        "user_id": f"eq.{user['id']}", "storage_id": f"eq.{sid}", "select": "access_type"
    })
    if not access or access[0].get("access_type", "") not in ("r", "a"):
        raise HTTPException(403, "No read access")

    files = await _supa("GET", "files", params={
        "storage_id": f"eq.{sid}", "path": f"eq.{path}", "select": "id"
    })
    if not files:
        raise HTTPException(404, "File not found")
    fid = files[0]["id"]

    chunks = await _supa("GET", "file_chunks", params={
        "file_id": f"eq.{fid}", "select": "telegram_file_id", "order": "position.asc"
    })
    if not chunks:
        raise HTTPException(404, "No chunks found")

    data = await tg_download(chunks[0]["telegram_file_id"])
    fname = path.split("/")[-1]
    return Response(content=data, media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})

@app.get("/api/files/{sid}/tree")
async def list_files(sid: str, path: str = "/", user: dict = Depends(get_user_from_header)):
    access = await _supa("GET", "access", params={
        "user_id": f"eq.{user['id']}", "storage_id": f"eq.{sid}", "select": "id"
    })
    if not access:
        raise HTTPException(403, "No access")

    prefix = path.rstrip("/") + "/" if path != "/" else ""
    files = await _supa("GET", "files", params={
        "storage_id": f"eq.{sid}", "select": "id,path,size,is_uploaded"
    })
    if prefix:
        files = [f for f in files if f.get("path", "").startswith(prefix)]
    return {"files": files, "path": path}

# Run
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=PORT, log_level="info")
