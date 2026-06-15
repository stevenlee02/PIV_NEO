"""
分析功能 —— 章节拆分、时间线、证据句、章节索引、章节元数据。
从 app.py 提取，可独立调试。
"""
import re
from collections import defaultdict
from text_utils import split_text_by_sentence, extract_persons
from normalizer import clean_name
from config import MIN_CHAPTERS_TO_RECOGNIZE, MAX_PARAGRAPH_CHUNKS


# ═══════════════════════════════════════════════════
# 章节拆分
# ═══════════════════════════════════════════════════

def split_into_chapters(text: str):
    """按章节标题拆分；无章节结构则回退段落拆分。"""
    if not text:
        return []

    normalized = re.sub(r"\r\n", "\n", text)

    chapter_patterns = [
        r"(Chapter\s+\d+)",            # Chapter 1
        r"(CHAPTER\s+\d+)",            # CHAPTER 1
        r"(CHAPTER\s+[IVXLCDM]+\.?)",  # CHAPTER I, II ...
    ]

    for pat in chapter_patterns:
        raw = re.split(pat, normalized, flags=re.MULTILINE | re.IGNORECASE)
        if len(raw) > 1:
            parts = []
            for i in range(1, len(raw), 2):
                title = raw[i].strip()
                body = raw[i + 1].strip() if i + 1 < len(raw) else ""
                parts.append(title + "\n" + body)

            if len(parts) >= MIN_CHAPTERS_TO_RECOGNIZE:
                return parts

    # 无章节 → 段落拆分
    paragraphs = re.split(r"\n\s*\n+", normalized)
    paragraphs = [p.strip() for p in paragraphs if p.strip()]

    if len(paragraphs) <= MAX_PARAGRAPH_CHUNKS:
        return paragraphs

    size = (len(paragraphs) + MAX_PARAGRAPH_CHUNKS - 1) // MAX_PARAGRAPH_CHUNKS
    merged = [
        "\n\n".join(paragraphs[i : i + size])
        for i in range(0, len(paragraphs), size)
    ]
    return merged


# ═══════════════════════════════════════════════════
# 时间线
# ═══════════════════════════════════════════════════

def compute_timeline(chapters: list, variant_to_canon: dict) -> dict:
    """
    统计每个 canonical 角色在每章的出现次数。
    返回: {"Mr Darcy": [ch1_count, ch2_count, ...], ...}
    """
    # canonical → {variants...}
    canon_to_variants = defaultdict(set)
    for variant, canon in variant_to_canon.items():
        canon_to_variants[canon].add(canon)
        canon_to_variants[canon].add(variant)

    timeline = defaultdict(lambda: [0] * len(chapters))

    for idx, chapter_text in enumerate(chapters):
        norm_text = re.sub(r"[^A-Za-z\s']", " ", chapter_text)
        norm_text = re.sub(r"\s+", " ", norm_text)

        for canon, variants in canon_to_variants.items():
            pattern_parts = []
            for v in variants:
                v_regex = re.escape(v).replace(r"\ ", r"\s+")
                pattern_parts.append(v_regex)

            if not pattern_parts:
                continue

            pattern = re.compile(
                r"\b(?:%s)\b" % "|".join(pattern_parts),
                re.IGNORECASE,
            )
            timeline[canon][idx] = len(pattern.findall(norm_text))

    print("Elizabeth timeline:", timeline.get("Elizabeth Bennet"))
    return timeline


# ═══════════════════════════════════════════════════
# 章节元数据
# ═══════════════════════════════════════════════════

def build_chapters_meta(chapters: list) -> list:
    """为每章生成 title + snippet，给前端 Timeline chapter card 用。"""
    meta = []
    for i, ch in enumerate(chapters, start=1):
        raw = (ch or "").strip()
        lines = raw.splitlines()
        body = "\n".join(lines[1:]).strip() if len(lines) > 1 else raw

        paras = [p.strip() for p in re.split(r"\n\s*\n+", body) if p.strip()]
        first_para = paras[0] if paras else ""
        snippet = re.sub(r"\s+", " ", first_para)

        meta.append({
            "index": i,
            "title": f"CHAPTER {i}",
            "snippet": snippet,
        })
    return meta


# ═══════════════════════════════════════════════════
# 句子 → 章节索引
# ═══════════════════════════════════════════════════

def build_sentence_chapter_index(chapters: list, nlp):
    """
    把每章拆成句子，记录每句属于哪一章 (1-based)。
    返回: (sentences, sent_persons, chapter_ids)
    """
    all_sents = []
    all_persons = []
    chapter_ids = []

    for ci, chapter_text in enumerate(chapters, start=1):
        sents = split_text_by_sentence(chapter_text, nlp)
        for sent in sents:
            raw_persons = extract_persons(sent, nlp)
            persons = []
            for p in raw_persons:
                p_clean = clean_name(p)
                if p_clean:
                    persons.append(p_clean)
            all_sents.append(sent)
            all_persons.append(persons)
            chapter_ids.append(ci)

    return all_sents, all_persons, chapter_ids


# ═══════════════════════════════════════════════════
# 证据句 (mentions)
# ═══════════════════════════════════════════════════

def build_mentions(chapters: list, variant_to_canon: dict, nlp,
                   limit_per_chapter: int = None) -> dict:
    """
    为每个角色收集在每章中出现的所有句子（证据句）。
    返回: {"Elizabeth Bennet": {"1": ["sent1", ...], "2": [...]}, ...}
    """
    mentions = defaultdict(lambda: defaultdict(list))

    for ci, chapter_text in enumerate(chapters, start=1):
        sents = split_text_by_sentence(chapter_text, nlp)

        for sent in sents:
            raw_persons = extract_persons(sent, nlp)
            canon_set = set()

            for p in raw_persons:
                p_clean = clean_name(p)
                if not p_clean:
                    continue
                canon = variant_to_canon.get(p_clean)
                if canon:
                    canon_set.add(canon)

            if not canon_set:
                continue

            for canon in canon_set:
                key = str(ci)
                if limit_per_chapter is None:
                    mentions[canon][key].append(sent)
                elif len(mentions[canon][key]) < limit_per_chapter:
                    mentions[canon][key].append(sent)

        # 每章内去重
        for canon in list(mentions.keys()):
            key = str(ci)
            if key in mentions[canon]:
                seen = set()
                uniq = []
                for s in mentions[canon][key]:
                    s_norm = re.sub(r"\s+", " ", s).strip()
                    if s_norm and s_norm not in seen:
                        seen.add(s_norm)
                        uniq.append(s_norm)
                mentions[canon][key] = uniq

    return mentions
