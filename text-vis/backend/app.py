"""
FastAPI 应用入口 —— 仅负责 HTTP 路由，业务逻辑全部在 orchestrator 中。
"""
import os
from fastapi import FastAPI, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import spacy
from openai import OpenAI
from dotenv import load_dotenv

from config import CORS_ORIGINS, SPACY_MODEL
from orchestrator import process_text

# ── 初始化 ──
load_dotenv()

app = FastAPI()
nlp = spacy.load(SPACY_MODEL)
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class TextData(BaseModel):
    text: str


# ── API 路由 ──

@app.post("/analyze")
async def analyze(file: UploadFile):
    """上传文件分析。"""
    text = (await file.read()).decode("utf-8", errors="ignore")
    return process_text(text, nlp, client)


@app.post("/analyze-text")
async def analyze_text(data: TextData):
    """直接提交文本分析。"""
    return process_text(data.text, nlp, client)


@app.get("/ping")
async def ping():
    return {"message": "pong", "key_loaded": bool(os.getenv("OPENAI_API_KEY"))}
