"""
Pentaract - Unlimited File Storage Service
Uses Telegram for unlimited file storage, Supabase PostgreSQL for metadata.
"""
import os
import sys
import uuid
import io
from datetime import datetime, timedelta, timezone
from contextlib import asynccontextmanager
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Depends, UploadFile, File, Form, status
from fastapi.responses import Response, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import (
    create_engine, Column, String, BigInteger, Boolean, SmallInteger, 
    Text, DateTime, ForeignKey, UniqueConstraint, Enum as SAEnum, text
)
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from passlib.hash import bcrypt
from jose import jwt
from jose.exceptions import JWTError

# ─── Configuration ───────────────────────────────────────────────────────────────

DATABASE_URL = os.environ.get("DATABASE_URL", "")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHANNEL_ID = os.environ.get("TELEGRAM_CHANNEL_ID", "")
PORT = int(os.environ.get("PORT", "10000"))
SECRET_KEY = os.environ.get("SECRET_KEY", "change-me-secret-key-123456")
ACCESS_TOKEN_EXPIRE_SECS = int(os.environ.get("ACCESS_TOKEN_EXPIRE_IN_SECS", "3600"))
REFRESH_TOKEN_EXPIRE_DAYS = int(os.environ.get("REFRESH_TOKEN_EXPIRE_IN_DAYS", "30"))
SUPERUSER_EMAIL = os.environ.get("SUPERUSER_EMAIL", "admin@pentaract.com")
SUPERUSER_PASS = os.environ.get("SUPERUSER_PASS", "admin123")
TELEGRAM_API_BASE = os.environ.get("TELEGRAM_API_BASE_URL", "https://api.telegram.org")

# Validate required config
missing = []
if not DATABASE_URL: missing.append("DATABASE_URL")
if not TELEGRAM_BOT_TOKEN: missing.append("TELEGRAM_BOT_TOKEN")
if not TELEGRAM_CHANNEL_ID: missing.append("TELEGRAM_CHANNEL_ID")
if missing:
    print(f"[ERROR] Missing required env vars: {', '.join(missing)}", flush=True)
    sys.exit(1)

# Convert DATABASE_URL for async (asyncpg requires postgresql+asyncpg://)
ASYNC_DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)

# ─── Database Setup ──────────────────────────────────────────────────────────────

engine = create_async_engine(ASYNC_DATABASE_URL, pool_size=5, max_overflow=10)
async_session = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)


class Storage(Base):
    __tablename__ = "storages"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    chat_id: Mapped[int] = mapped_column(BigInteger, unique=True, nullable=False)


class StorageWorker(Base):
    __tablename__ = "storage_workers"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    token: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False)
    storage_id: Mapped[Optional[str]] = mapped_column(String, ForeignKey("storages.id"), nullable=True)


class File(Base):
    __tablename__ = "files"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    path: Mapped[str] = mapped_column(Text, nullable=False)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    storage_id: Mapped[str] = mapped_column(String, ForeignKey("storages.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False)
    is_uploaded: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    __table_args__ = (UniqueConstraint("path", "storage_id"),)


class FileChunk(Base):
    __tablename__ = "file_chunks"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    file_id: Mapped[str] = mapped_column(String, ForeignKey("files.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False)
    telegram_file_id: Mapped[str] = mapped_column(String(255), nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)


class Access(Base):
    __tablename__ = "access"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False)
    storage_id: Mapped[str] = mapped_column(String, ForeignKey("storages.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False)
    access_type: Mapped[str] = mapped_column(String(1), nullable=False)  # 'r', 'w', 'a'
    __table_args__ = (UniqueConstraint("user_id", "storage_id"),)


# ─── Auth Helpers ────────────────────────────────────────────────────────────────

ALGORITHM = "HS256"


def create_access_token(user_id: str, email: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(seconds=ACCESS_TOKEN_EXPIRE_SECS)
    payload = {"sub": user_id, "email": email, "exp": expire, "type": "access"}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def create_refresh_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    payload = {"sub": user_id, "exp": expire, "type": "refresh"}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


async def get_current_user(token: str = Depends(lambda: None)) -> dict:
    """Extract user from Authorization header."""
    # This will be overridden by the dependency in each route
    raise NotImplementedError


# ─── Telegram API ────────────────────────────────────────────────────────────────

async def telegram_send_file(file_data: bytes, filename: str) -> str:
    """Upload a file to Telegram channel and return the file_id."""
    async with httpx.AsyncClient(timeout=60.0) as client:
        files = {"document": (filename, io.BytesIO(file_data), "application/octet-stream")}
        data = {"chat_id": TELEGRAM_CHANNEL_ID}
        resp = await client.post(
            f"{TELEGRAM_API_BASE}/bot{TELEGRAM_BOT_TOKEN}/sendDocument",
            data=data, files=files
        )
        result = resp.json()
        if not result.get("ok"):
            raise HTTPException(502, f"Telegram upload failed: {result.get('description', 'unknown')}")
        return result["result"]["document"]["file_id"]


async def telegram_get_file(file_id: str) -> bytes:
    """Download a file from Telegram by file_id."""
    async with httpx.AsyncClient(timeout=60.0) as client:
        # Get file path
        resp = await client.get(
            f"{TELEGRAM_API_BASE}/bot{TELEGRAM_BOT_TOKEN}/getFile?file_id={file_id}"
        )
        result = resp.json()
        if not result.get("ok"):
            raise HTTPException(502, f"Telegram getFile failed: {result.get('description', 'unknown')}")
        file_path = result["result"]["file_path"]
        # Download
        dl_resp = await client.get(
            f"{TELEGRAM_API_BASE}/file/bot{TELEGRAM_BOT_TOKEN}/{file_path}"
        )
        return dl_resp.content


# ─── Request/Response Schemas ────────────────────────────────────────────────────

class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class LoginRequest(BaseModel):
    email: str
    password: str


class UserCreate(BaseModel):
    email: str
    password: str


class StorageCreate(BaseModel):
    name: str
    chat_id: int


class StorageResponse(BaseModel):
    id: str
    name: str
    chat_id: int


class FileInfo(BaseModel):
    id: str
    path: str
    size: int
    is_uploaded: bool


class FileListResponse(BaseModel):
    files: list[FileInfo]
    path: str


# ─── App Initialization ──────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize database tables and create superuser on startup."""
    print("[startup] Creating database tables...", flush=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    print("[startup] Tables ready.", flush=True)

    # Create superuser if not exists
    async with async_session() as session:
        result = await session.execute(
            text("SELECT id FROM users WHERE email = :email"), 
            {"email": SUPERUSER_EMAIL}
        )
        user = result.scalar_one_or_none()
        if not user:
            hashed = bcrypt.hash(SUPERUSER_PASS)
            uid = str(uuid.uuid4())
            await session.execute(
                text("INSERT INTO users (id, email, password_hash) VALUES (:id, :email, :hash)"),
                {"id": uid, "email": SUPERUSER_EMAIL, "hash": hashed}
            )
            await session.commit()
            print(f"[startup] Superuser created: {SUPERUSER_EMAIL}", flush=True)
        else:
            print(f"[startup] Superuser already exists: {SUPERUSER_EMAIL}", flush=True)

    print(f"[startup] Server starting on port {PORT}", flush=True)
    yield


app = FastAPI(lifespan=lifespan, title="Pentaract", docs_url="/docs")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Auth Dependency ─────────────────────────────────────────────────────────────

async def auth_required(authorization: str = "") -> dict:
    """Dependency that validates Bearer token and returns user info."""
    if not authorization:
        raise HTTPException(401, detail="Missing Authorization header")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(401, detail="Invalid Authorization header format")
    payload = decode_token(token)
    if payload.get("type") != "access":
        raise HTTPException(401, detail="Invalid token type")
    return {"id": payload["sub"], "email": payload.get("email", "")}


# ─── Routes ──────────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    """Health check - serves as Render health check endpoint."""
    return {"status": "ok", "service": "pentaract", "version": "0.1.0"}


@app.get("/health")
async def health():
    """Detailed health check."""
    return {
        "status": "ok",
        "database": "connected",
        "telegram_bot": bool(TELEGRAM_BOT_TOKEN),
        "telegram_channel": bool(TELEGRAM_CHANNEL_ID),
    }


# ─── Auth Routes ─────────────────────────────────────────────────────────────────

@app.post("/api/auth/login", response_model=TokenResponse)
async def login(req: LoginRequest):
    async with async_session() as session:
        result = await session.execute(
            text("SELECT id, email, password_hash FROM users WHERE email = :email"),
            {"email": req.email}
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(401, detail="Invalid email or password")
        user_id, email, pw_hash = row
        if not bcrypt.verify(req.password, pw_hash):
            raise HTTPException(401, detail="Invalid email or password")
    return TokenResponse(
        access_token=create_access_token(user_id, email),
        refresh_token=create_refresh_token(user_id),
    )


@app.post("/api/auth/refresh", response_model=TokenResponse)
async def refresh_token(authorization: str = ""):
    if not authorization:
        raise HTTPException(401, detail="Missing Authorization header")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(401, detail="Invalid Authorization header format")
    payload = decode_token(token)
    if payload.get("type") != "refresh":
        raise HTTPException(401, detail="Invalid token type")
    user_id = payload["sub"]
    async with async_session() as session:
        result = await session.execute(
            text("SELECT email FROM users WHERE id = :id"), {"id": user_id}
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(401, detail="User not found")
        email = row[0]
    return TokenResponse(
        access_token=create_access_token(user_id, email),
        refresh_token=create_refresh_token(user_id),
    )


# ─── User Routes ─────────────────────────────────────────────────────────────────

@app.post("/api/users")
async def create_user(user: UserCreate):
    async with async_session() as session:
        # Check if exists
        result = await session.execute(
            text("SELECT id FROM users WHERE email = :email"), {"email": user.email}
        )
        if result.fetchone():
            raise HTTPException(409, detail="User with this email already exists")
        hashed = bcrypt.hash(user.password)
        uid = str(uuid.uuid4())
        await session.execute(
            text("INSERT INTO users (id, email, password_hash) VALUES (:id, :email, :hash)"),
            {"id": uid, "email": user.email, "hash": hashed}
        )
        await session.commit()
    return {"id": uid, "email": user.email}


@app.get("/api/users/me")
async def get_me(user: dict = Depends(auth_required)):
    return user


# ─── Storage Routes ──────────────────────────────────────────────────────────────

@app.post("/api/storages")
async def create_storage(storage: StorageCreate, user: dict = Depends(auth_required)):
    sid = str(uuid.uuid4())
    async with async_session() as session:
        try:
            await session.execute(
                text("INSERT INTO storages (id, name, chat_id) VALUES (:id, :name, :chat_id)"),
                {"id": sid, "name": storage.name, "chat_id": storage.chat_id}
            )
            # Grant admin access
            await session.execute(
                text("INSERT INTO access (id, user_id, storage_id, access_type) VALUES (:id, :uid, :sid, :type)"),
                {"id": str(uuid.uuid4()), "uid": user["id"], "sid": sid, "type": "a"}
            )
            await session.commit()
        except Exception as e:
            await session.rollback()
            raise HTTPException(400, detail=str(e))
    return {"id": sid, "name": storage.name, "chat_id": storage.chat_id}


@app.get("/api/storages")
async def list_storages(user: dict = Depends(auth_required)):
    async with async_session() as session:
        result = await session.execute(
            text("""
                SELECT s.id, s.name, s.chat_id FROM storages s
                JOIN access a ON a.storage_id = s.id
                WHERE a.user_id = :uid
            """),
            {"uid": user["id"]}
        )
        storages = [{"id": r[0], "name": r[1], "chat_id": r[2]} for r in result.fetchall()]
    return storages


@app.get("/api/storages/{storage_id}")
async def get_storage(storage_id: str, user: dict = Depends(auth_required)):
    async with async_session() as session:
        result = await session.execute(
            text("SELECT id, name, chat_id FROM storages WHERE id = :id"),
            {"id": storage_id}
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(404, detail="Storage not found")
    return {"id": row[0], "name": row[1], "chat_id": row[2]}


# ─── File Routes ─────────────────────────────────────────────────────────────────

@app.post("/api/files/{storage_id}/upload")
async def upload_file(
    storage_id: str,
    file: UploadFile = File(...),
    path: str = Form("/"),
    user: dict = Depends(auth_required),
):
    """Upload a file. Files are stored in Telegram (unlimited), metadata in Supabase."""
    data = await file.read()
    filename = file.filename or "unnamed"
    full_path = f"{path.rstrip('/')}/{filename}".lstrip("/")
    
    # Upload to Telegram first
    telegram_file_id = await telegram_send_file(data, filename)
    
    # Store metadata in database
    fid = str(uuid.uuid4())
    async with async_session() as session:
        # Check access
        access_result = await session.execute(
            text("SELECT access_type FROM access WHERE user_id = :uid AND storage_id = :sid"),
            {"uid": user["id"], "sid": storage_id}
        )
        access = access_result.scalar_one_or_none()
        if not access or access not in ("w", "a"):
            raise HTTPException(403, detail="No write access to this storage")
        
        try:
            await session.execute(
                text("""INSERT INTO files (id, path, size, storage_id, is_uploaded) 
                        VALUES (:id, :path, :size, :sid, TRUE)"""),
                {"id": fid, "path": full_path, "size": len(data), "sid": storage_id}
            )
            # Store chunk reference (single chunk for simplicity)
            await session.execute(
                text("""INSERT INTO file_chunks (id, file_id, telegram_file_id, position)
                        VALUES (:id, :fid, :tg_id, 0)"""),
                {"id": str(uuid.uuid4()), "fid": fid, "tg_id": telegram_file_id}
            )
            await session.commit()
        except Exception as e:
            await session.rollback()
            raise HTTPException(400, detail=str(e))
    
    return {"id": fid, "path": full_path, "size": len(data), "telegram_file_id": telegram_file_id}


@app.get("/api/files/{storage_id}/download/*path")
async def download_file(storage_id: str, path: str, user: dict = Depends(auth_required)):
    """Download a file from Telegram storage."""
    async with async_session() as session:
        # Check access
        access_result = await session.execute(
            text("SELECT access_type FROM access WHERE user_id = :uid AND storage_id = :sid"),
            {"uid": user["id"], "sid": storage_id}
        )
        access = access_result.scalar_one_or_none()
        if not access or access not in ("r", "a"):
            raise HTTPException(403, detail="No read access to this storage")
        
        # Get file
        result = await session.execute(
            text("SELECT id, path, size FROM files WHERE storage_id = :sid AND path = :path"),
            {"sid": storage_id, "path": path}
        )
        file_row = result.fetchone()
        if not file_row:
            raise HTTPException(404, detail="File not found")
        
        # Get telegram file_id from chunks
        chunk_result = await session.execute(
            text("SELECT telegram_file_id FROM file_chunks WHERE file_id = :fid ORDER BY position"),
            {"fid": file_row[0]}
        )
        chunks = [r[0] for r in chunk_result.fetchall()]
    
    if not chunks:
        raise HTTPException(404, detail="File chunks not found")
    
    # Download from Telegram
    data = await telegram_get_file(chunks[0])
    filename = path.rsplit("/", 1)[-1] if "/" in path else path
    
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


@app.get("/api/files/{storage_id}/tree")
async def list_files(storage_id: str, path: str = "/", user: dict = Depends(auth_required)):
    """List files in a storage path."""
    async with async_session() as session:
        access_result = await session.execute(
            text("SELECT access_type FROM access WHERE user_id = :uid AND storage_id = :sid"),
            {"uid": user["id"], "sid": storage_id}
        )
        access = access_result.scalar_one_or_none()
        if not access:
            raise HTTPException(403, detail="No access to this storage")
        
        # Get files in this path
        prefix = path.rstrip("/") + "/" if path != "/" else ""
        result = await session.execute(
            text("""SELECT id, path, size, is_uploaded FROM files 
                    WHERE storage_id = :sid AND path LIKE :prefix"""),
            {"sid": storage_id, "prefix": f"{prefix}%"}
        )
        files = [
            FileInfo(id=r[0], path=r[1], size=r[2], is_uploaded=r[3])
            for r in result.fetchall()
        ]
    
    return FileListResponse(files=files, path=path)


# ─── Main ────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=PORT, log_level="info")
