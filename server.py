"""Minimal Pentaract server - starts fast, minimal deps"""
import os
import sys

# Delay heavy imports to after basic startup succeeds
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware

DATABASE_URL = os.environ.get("DATABASE_URL", "")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHANNEL_ID = os.environ.get("TELEGRAM_CHANNEL_ID", "")
PORT = int(os.environ.get("PORT", "10000"))
SECRET_KEY = os.environ.get("SECRET_KEY", "change-me-secret-key-123456")
SUPERUSER_EMAIL = os.environ.get("SUPERUSER_EMAIL", "admin@pentaract.com")
SUPERUSER_PASS = os.environ.get("SUPERUSER_PASS", "admin123")

# Validate required config
missing = []
if not DATABASE_URL: missing.append("DATABASE_URL")
if not TELEGRAM_BOT_TOKEN: missing.append("TELEGRAM_BOT_TOKEN")
if not TELEGRAM_CHANNEL_ID: missing.append("TELEGRAM_CHANNEL_ID")
if missing:
    print(f"[FATAL] Missing required env vars: {', '.join(missing)}", flush=True)
    sys.exit(1)

app = FastAPI(title="Pentaract")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.on_event("startup")
async def startup():
    """Initialize database and Telegram integration on startup."""
    print("[startup] Pentaract starting up...", flush=True)
    
    # Import heavy modules only at startup
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    from sqlalchemy import text
    
    async_url = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)
    
    print(f"[startup] Connecting to database...", flush=True)
    engine = create_async_engine(async_url, pool_size=2, max_overflow=5)
    
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
            print(f"[startup] Database connection OK", flush=True)
    except Exception as e:
        print(f"[startup] Database connection FAILED: {e}", flush=True)
        raise
    
    # Create tables
    from sqlalchemy import (Column, String, BigInteger, Boolean, SmallInteger,
                            Text, DateTime, ForeignKey, UniqueConstraint)
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
        chat_id = Column(BigInteger, unique=True, nullable=False)
    
    class StorageWorker(Base):
        __tablename__ = "storage_workers"
        id = Column(String, primary_key=True)
        name = Column(String(255), nullable=False)
        token = Column(String(255), unique=True, nullable=False)
        user_id = Column(String, ForeignKey("users.id"), nullable=False)
        storage_id = Column(String, ForeignKey("storages.id"), nullable=True)
    
    class File(Base):
        __tablename__ = "files"
        id = Column(String, primary_key=True)
        path = Column(Text, nullable=False)
        size = Column(BigInteger, nullable=False)
        storage_id = Column(String, ForeignKey("storages.id"), nullable=False)
        is_uploaded = Column(Boolean, nullable=False, default=False)
        __table_args__ = (UniqueConstraint("path", "storage_id"),)
    
    class FileChunk(Base):
        __tablename__ = "file_chunks"
        id = Column(String, primary_key=True)
        file_id = Column(String, ForeignKey("files.id"), nullable=False)
        telegram_file_id = Column(String(255), nullable=False)
        position = Column(SmallInteger, nullable=False)
    
    class Access(Base):
        __tablename__ = "access"
        id = Column(String, primary_key=True)
        user_id = Column(String, ForeignKey("users.id"), nullable=False)
        storage_id = Column(String, ForeignKey("storages.id"), nullable=False)
        access_type = Column(String(1), nullable=False)
        __table_args__ = (UniqueConstraint("user_id", "storage_id"),)
    
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        print("[startup] Tables created/verified", flush=True)
    
    # Create superuser
    from passlib.hash import bcrypt
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
            print(f"[startup] Superuser created: {SUPERUSER_EMAIL}", flush=True)
    
    # Store engine in app state
    app.state.engine = engine
    print("[startup] Ready!", flush=True)


@app.get("/")
async def root():
    return {"status": "ok", "service": "pentaract", "version": "0.1.0"}


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "database": "connected",
        "telegram_bot": bool(TELEGRAM_BOT_TOKEN),
        "telegram_channel": bool(TELEGRAM_CHANNEL_ID),
    }
