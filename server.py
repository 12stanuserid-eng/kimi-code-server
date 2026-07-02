"""Pentaract - unlimited file storage server (Telegram + Supabase)"""
import os
import sys
import uuid
import io
from datetime import datetime, timedelta, timezone
from typing import Optional
import asyncio

OS_ENV = os.environ

DATABASE_URL = OS_ENV.get("DATABASE_URL", "")
TELEGRAM_BOT_TOKEN = OS_ENV.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHANNEL_ID = OS_ENV.get("TELEGRAM_CHANNEL_ID", "")
PORT = int(OS_ENV.get("PORT", "10000"))
SECRET_KEY = OS_ENV.get("SECRET_KEY", "change-me-secret-key")
ACCESS_TOKEN_EXPIRE_SECS = int(OS_ENV.get("ACCESS_TOKEN_EXPIRE_IN_SECS", "3600"))
REFRESH_TOKEN_EXPIRE_DAYS = int(OS_ENV.get("REFRESH_TOKEN_EXPIRE_IN_DAYS", "30"))
SUPERUSER_EMAIL = OS_ENV.get("SUPERUSER_EMAIL", "admin@pentaract.com")
SUPERUSER_PASS = OS_ENV.get("SUPERUSER_PASS", "admin123")
TELEGRAM_API_BASE = OS_ENV.get("TELEGRAM_API_BASE_URL", "https://api.telegram.org")

# Validate (warn only, don't exit — /health will report status)
missing = [k for k, v in [
    ("DATABASE_URL", DATABASE_URL),
    ("TELEGRAM_BOT_TOKEN", TELEGRAM_BOT_TOKEN),
    ("TELEGRAM_CHANNEL_ID", TELEGRAM_CHANNEL_ID),
] if not v]
if missing:
    print(f"[WARN] Missing env vars: {', '.join(missing)} — /health will show degraded status", flush=True)

ASYNC_DB_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)

from fastapi import FastAPI, HTTPException, Depends, UploadFile, File, Form
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="Pentaract")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# Lazy-loaded globals
_db_engine = None
_db_ready = False


async def get_db():
    global _db_engine, _db_ready
    if _db_engine is None:
        from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
        _db_engine = create_async_engine(ASYNC_DB_URL, pool_size=2, max_overflow=5)
        try:
            async with _db_engine.connect() as conn:
                from sqlalchemy import text
                await conn.execute(text("SELECT 1"))
            print("[db] Connected", flush=True)
            _db_ready = True
        except Exception as e:
            print(f"[db] Connection failed: {e}", flush=True)
            raise
    return _db_engine


async def init_tables(engine):
    """Create tables if needed."""
    from sqlalchemy import (Column, String, BigInteger, Boolean, SmallInteger,
                            Text, ForeignKey, UniqueConstraint, MetaData)
    from sqlalchemy.orm import DeclarativeBase

    class Base(DeclarativeBase):
        pass

    class User(Base):
        __tablename__ = "users"
        id = Column(String, primary_key=True)
        email = Column(String(255), unique=True, nullable=False)
        password_hash = Column(String(255), nullable=False)

    class Storage(Base):
        __tablename__ = "storages"
        id = Column(String, primary_key=True)
        name = Column(String(255), nullable=False)
        chat_id = Column(int, unique=True, nullable=False)

    class FileRecord(Base):
        __tablename__ = "files"
        id = Column(String, primary_key=True)
        path = Column(Text, nullable=False)
        size = Column(int, nullable=False)
        storage_id = Column(String, ForeignKey("storages.id"), nullable=False)
        is_uploaded = Column(Boolean, nullable=False, default=False)
        __table_args__ = (UniqueConstraint("path", "storage_id"),)

    class FileChunk(Base):
        __tablename__ = "file_chunks"
        id = Column(String, primary_key=True)
        file_id = Column(String, ForeignKey("files.id"), nullable=False)
        telegram_file_id = Column(String(255), nullable=False)
        position = Column(int, nullable=False)

    class Access(Base):
        __tablename__ = "access"
        id = Column(String, primary_key=True)
        user_id = Column(String, ForeignKey("users.id"), nullable=False)
        storage_id = Column(String, ForeignKey("storages.id"), nullable=False)
        access_type = Column(String(1), nullable=False)
        __table_args__ = (UniqueConstraint("user_id", "storage_id"),)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    print("[db] Tables ready", flush=True)

    # Superuser
    from passlib.hash import bcrypt
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        result = await session.execute(
            text("SELECT id FROM users WHERE email = :email"),
            {"email": SUPERUSER_EMAIL}
        )
        if not result.scalar_one_or_none():
            uid = str(uuid.uuid4())
            await session.execute(
                text("INSERT INTO users (id, email, password_hash) VALUES (:id, :email, :hash)"),
                {"id": uid, "email": SUPERUSER_EMAIL, "hash": bcrypt.hash(SUPERUSER_PASS)}
            )
            await session.commit()
            print(f"[db] Superuser created: {SUPERUSER_EMAIL}", flush=True)


async def init_background():
    """Initialize DB in background task."""
    global _db_ready
    try:
        engine = await get_db()
        await init_tables(engine)
        _db_ready = True
        print("[startup] Background init complete", flush=True)
    except Exception as e:
        print(f"[startup] Background init FAILED: {e}", flush=True)


@app.on_event("startup")
async def startup():
    print(f"[startup] Pentaract starting on port {PORT}", flush=True)
    print(f"[startup] DB URL: {ASYNC_DB_URL[:60]}...", flush=True)
    print(f"[startup] Telegram bot: {TELEGRAM_BOT_TOKEN[:10]}...", flush=True)
    print(f"[startup] Telegram channel: {TELEGRAM_CHANNEL_ID}", flush=True)
    # Start DB init in background - don't block server startup
    asyncio.create_task(init_background())
    print("[startup] Server is live", flush=True)


# ─── Auth helpers ────────────────────────────────────────────────────────────

from passlib.hash import bcrypt
from jose import jwt
from jose.exceptions import JWSError
ALGO = "HS256"


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


async def get_user_from_header(authorization: str = "") -> dict:
    if not authorization:
        raise HTTPException(401, detail="Missing Authorization header")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(401, detail="Invalid Authorization header")
    payload = verify_token(token)
    if payload.get("type") != "access":
        raise HTTPException(401, detail="Invalid token type")
    return {"id": payload["sub"], "email": payload.get("email", "")}


# ─── Telegram helpers ───────────────────────────────────────────────────────

async def tg_upload(data: bytes, name: str) -> str:
    import httpx
    async with httpx.AsyncClient(timeout=60) as c:
        files = {"document": (name, io.BytesIO(data), "application/octet-stream")}
        r = await c.post(f"{TELEGRAM_API_BASE}/bot{TELEGRAM_BOT_TOKEN}/sendDocument",
                         data={"chat_id": TELEGRAM_CHANNEL_ID}, files=files)
        j = r.json()
        if not j.get("ok"):
            raise HTTPException(502, f"Telegram upload failed: {j.get('description', '?')}")
        return j["result"]["document"]["file_id"]


async def tg_download(file_id: str) -> bytes:
    import httpx
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.get(f"{TELEGRAM_API_BASE}/bot{TELEGRAM_BOT_TOKEN}/getFile?file_id={file_id}")
        j = r.json()
        if not j.get("ok"):
            raise HTTPException(502, f"Telegram getFile failed: {j.get('description', '?')}")
        fp = j["result"]["file_path"]
        dl = await c.get(f"{TELEGRAM_API_BASE}/file/bot{TELEGRAM_BOT_TOKEN}/{fp}")
        return dl.content


# ─── Routes ─────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {"status": "ok", "service": "pentaract", "version": "0.1.0"}


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "db_ready": _db_ready,
        "telegram_bot": bool(TELEGRAM_BOT_TOKEN),
        "telegram_channel": bool(TELEGRAM_CHANNEL_ID),
    }


# Auth
@app.post("/api/auth/login")
async def login(email: str = Form(...), password: str = Form(...)):
    from sqlalchemy import text
    engine = await get_db()
    from sqlalchemy.ext.asyncio import async_sessionmaker
    async with async_sessionmaker(engine, expire_on_commit=False)() as s:
        r = await s.execute(text("SELECT id, email, password_hash FROM users WHERE email=:email"), {"email": email})
        row = r.fetchone()
        if not row or not bcrypt.verify(password, row[2]):
            raise HTTPException(401, detail="Invalid credentials")
    return {"access_token": make_access_token(row[0], row[1]), "refresh_token": make_refresh_token(row[0]),
            "token_type": "bearer"}


@app.post("/api/auth/refresh")
async def refresh(authorization: str = ""):
    user = await get_user_from_header(authorization)
    # Verify user still exists
    from sqlalchemy import text
    engine = await get_db()
    from sqlalchemy.ext.asyncio import async_sessionmaker
    async with async_sessionmaker(engine, expire_on_commit=False)() as s:
        r = await s.execute(text("SELECT email FROM users WHERE id=:id"), {"id": user["id"]})
        row = r.fetchone()
        if not row:
            raise HTTPException(401, detail="User not found")
    return {"access_token": make_access_token(user["id"], row[0]), "refresh_token": make_refresh_token(user["id"]),
            "token_type": "bearer"}


# Users
@app.post("/api/users")
async def create_user(email: str = Form(...), password: str = Form(...)):
    from sqlalchemy import text
    engine = await get_db()
    from sqlalchemy.ext.asyncio import async_sessionmaker
    async with async_sessionmaker(engine, expire_on_commit=False)() as s:
        r = await s.execute(text("SELECT id FROM users WHERE email=:email"), {"email": email})
        if r.fetchone():
            raise HTTPException(409, detail="Email already exists")
        uid = str(uuid.uuid4())
        await s.execute(text("INSERT INTO users (id, email, password_hash) VALUES (:id, :email, :hash)"),
                        {"id": uid, "email": email, "hash": bcrypt.hash(password)})
        await s.commit()
    return {"id": uid, "email": email}


@app.get("/api/users/me")
async def me(user: dict = Depends(get_user_from_header)):
    return user


# Storages
@app.post("/api/storages")
async def create_storage(name: str = Form(...), chat_id: int = Form(...),
                         user: dict = Depends(get_user_from_header)):
    from sqlalchemy import text
    engine = await get_db()
    from sqlalchemy.ext.asyncio import async_sessionmaker
    sid = str(uuid.uuid4())
    async with async_sessionmaker(engine, expire_on_commit=False)() as s:
        try:
            await s.execute(text("INSERT INTO storages (id, name, chat_id) VALUES (:id, :n, :c)"),
                            {"id": sid, "n": name, "c": chat_id})
            await s.execute(text("INSERT INTO access (id, user_id, storage_id, access_type) VALUES (:id, :uid, :sid, 'a')"),
                            {"id": str(uuid.uuid4()), "uid": user["id"], "sid": sid})
            await s.commit()
        except Exception as e:
            await s.rollback()
            raise HTTPException(400, detail=str(e))
    return {"id": sid, "name": name, "chat_id": chat_id}


@app.get("/api/storages")
async def list_storages(user: dict = Depends(get_user_from_header)):
    from sqlalchemy import text
    engine = await get_db()
    from sqlalchemy.ext.asyncio import async_sessionmaker
    async with async_sessionmaker(engine, expire_on_commit=False)() as s:
        r = await s.execute(
            text("SELECT s.id, s.name, s.chat_id FROM storages s JOIN access a ON a.storage_id=s.id WHERE a.user_id=:uid"),
            {"uid": user["id"]})
        return [{"id": row[0], "name": row[1], "chat_id": row[2]} for row in r.fetchall()]


@app.get("/api/storages/{sid}")
async def get_storage(sid: str, user: dict = Depends(get_user_from_header)):
    from sqlalchemy import text
    engine = await get_db()
    from sqlalchemy.ext.asyncio import async_sessionmaker
    async with async_sessionmaker(engine, expire_on_commit=False)() as s:
        r = await s.execute(text("SELECT id, name, chat_id FROM storages WHERE id=:id"), {"id": sid})
        row = r.fetchone()
        if not row:
            raise HTTPException(404, detail="Storage not found")
    return {"id": row[0], "name": row[1], "chat_id": row[2]}


# Files
@app.post("/api/files/{sid}/upload")
async def upload_file(sid: str, file: UploadFile = File(...), path: str = Form("/"),
                      user: dict = Depends(get_user_from_header)):
    """Upload file to Telegram (unlimited storage) and store metadata in Supabase."""
    data = await file.read()
    fname = file.filename or "unnamed"
    full_path = f"{path.rstrip('/')}/{fname}".lstrip("/")

    # Upload to Telegram
    tg_id = await tg_upload(data, fname)

    from sqlalchemy import text
    engine = await get_db()
    from sqlalchemy.ext.asyncio import async_sessionmaker
    fid = str(uuid.uuid4())
    async with async_sessionmaker(engine, expire_on_commit=False)() as s:
        # Check access
        a = await s.execute(text("SELECT access_type FROM access WHERE user_id=:uid AND storage_id=:sid"),
                            {"uid": user["id"], "sid": sid})
        at = a.scalar_one_or_none()
        if not at or at not in ("w", "a"):
            raise HTTPException(403, "No write access")
        try:
            await s.execute(text("INSERT INTO files (id, path, size, storage_id, is_uploaded) VALUES (:id, :p, :sz, :sid, TRUE)"),
                            {"id": fid, "p": full_path, "sz": len(data), "sid": sid})
            await s.execute(text("INSERT INTO file_chunks (id, file_id, telegram_file_id, position) VALUES (:id, :fid, :tg, 0)"),
                            {"id": str(uuid.uuid4()), "fid": fid, "tg": tg_id})
            await s.commit()
        except Exception as e:
            await s.rollback()
            raise HTTPException(400, detail=str(e))
    return {"id": fid, "path": full_path, "size": len(data), "telegram_file_id": tg_id}


@app.get("/api/files/{sid}/download/{path:path}")
async def download_file(sid: str, path: str, user: dict = Depends(get_user_from_header)):
    from sqlalchemy import text
    engine = await get_db()
    from sqlalchemy.ext.asyncio import async_sessionmaker
    async with async_sessionmaker(engine, expire_on_commit=False)() as s:
        a = await s.execute(text("SELECT access_type FROM access WHERE user_id=:uid AND storage_id=:sid"),
                            {"uid": user["id"], "sid": sid})
        at = a.scalar_one_or_none()
        if not at or at not in ("r", "a"):
            raise HTTPException(403, "No read access")
        r = await s.execute(text("SELECT id, path FROM files WHERE storage_id=:sid AND path=:path"),
                            {"sid": sid, "path": path})
        row = r.fetchone()
        if not row:
            raise HTTPException(404, "File not found")
        cr = await s.execute(text("SELECT telegram_file_id FROM file_chunks WHERE file_id=:fid ORDER BY position"),
                             {"fid": row[0]})
        chunks = [c[0] for c in cr.fetchall()]
    if not chunks:
        raise HTTPException(404, "No chunks found")
    data = await tg_download(chunks[0])
    fname = path.split("/")[-1]
    return Response(content=data, media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@app.get("/api/files/{sid}/tree")
async def list_files(sid: str, path: str = "/", user: dict = Depends(get_user_from_header)):
    from sqlalchemy import text
    engine = await get_db()
    from sqlalchemy.ext.asyncio import async_sessionmaker
    async with async_sessionmaker(engine, expire_on_commit=False)() as s:
        a = await s.execute(text("SELECT access_type FROM access WHERE user_id=:uid AND storage_id=:sid"),
                            {"uid": user["id"], "sid": sid})
        if not a.scalar_one_or_none():
            raise HTTPException(403, "No access")
        prefix = path.rstrip("/") + "/" if path != "/" else ""
        r = await s.execute(text("SELECT id, path, size, is_uploaded FROM files WHERE storage_id=:sid AND path LIKE :prefix"),
                            {"sid": sid, "prefix": f"{prefix}%"})
        files = [{"id": row[0], "path": row[1], "size": row[2], "is_uploaded": row[3]} for row in r.fetchall()]
    return {"files": files, "path": path}


# Run
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=PORT, log_level="info")
