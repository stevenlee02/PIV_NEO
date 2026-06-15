"""
文本清理 + NLP 基础工具函数。
从 app.py 提取，可独立调试。
"""
import re
from config import MIN_SENTENCE_LENGTH


def clean_illustrations(text: str) -> str:
    """
    移除 Gutenberg 插图标记，例如：
      [Illustration: ...]
      [Illustration ...]
      [_Copyright 1894 by ...]
    """
    text = re.sub(
        r"\[.*?illustration.*?\]",
        "",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    text = re.sub(
        r"\[_copyright.*?\]",
        "",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    return text


def split_text_by_sentence(text: str, nlp) -> list:
    """按句子拆分，过滤掉过短的句子。"""
    text = re.sub(r"\s+", " ", text)
    doc = nlp(text)
    return [
        sent.text.strip()
        for sent in doc.sents
        if len(sent.text.strip()) > MIN_SENTENCE_LENGTH
    ]


def extract_persons(chunk: str, nlp) -> list:
    """从文本片段中提取 PERSON 实体。"""
    doc = nlp(chunk)
    return [ent.text.strip() for ent in doc.ents if ent.label_ == "PERSON"]
