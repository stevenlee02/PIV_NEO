"""
名字规范化 —— 清洗、GPT 聚合、映射构建、变体输出。
从 app.py 提取，可独立调试（GPT 调用部分需要 mock client 即可）。
"""
import json
import re
from collections import defaultdict
from config import (
    BLACKLIST,
    HONORIFICS,
    SKIP_WORDS,
    GPT_MODEL,
    GPT_TEMPERATURE,
    SHORT_TEXT_THRESHOLD,
)


# ═══════════════════════════════════════════════════
# 名字清洗
# ═══════════════════════════════════════════════════

def clean_name(name: str) -> str:
    """清洗单个名字：去标点、去 honorific、黑名单过滤。"""
    if not name:
        return ""

    name = re.sub(r"[\r\n]+", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    name = re.sub(r"[\[\(\{].*?[\]\)\}]", "", name)
    name = re.sub(r"[^A-Za-z\s']", "", name).strip()

    if not name:
        return ""

    parts = name.split()
    if not parts:
        return ""

    # 单独的 honorific 丢弃
    if parts[0].lower().strip(".") in HONORIFICS and len(parts) == 1:
        return ""

    name_cleaned = " ".join(p.capitalize() for p in parts)

    # 去掉残留的虚词
    name_cleaned = re.sub(
        r"\b(but|said|says|then|also)\b",
        "",
        name_cleaned,
        flags=re.IGNORECASE,
    ).strip()

    # 黑名单
    lname = name_cleaned.lower()
    for bad in BLACKLIST:
        if bad in lname:
            return ""

    return name_cleaned


# ═══════════════════════════════════════════════════
# 映射增强 & 变体
# ═══════════════════════════════════════════════════

def enhance_mapping(variant_to_canon: dict, all_extracted_names: list,
                    skip_words: list = None) -> dict:
    """
    从现有名字中做部分匹配，不创建新名字。
    例："Elizabeth Bennet" 中的 "Elizabeth" 也出现在名字列表
        → 自动映射到同一 canonical。
    """
    if skip_words is None:
        skip_words = []

    enhanced = variant_to_canon.copy()
    all_names_set = set(all_extracted_names)

    for existing_variant in list(enhanced.keys()):
        parts = existing_variant.split()
        if len(parts) <= 1:
            continue

        for part in parts:
            if (
                len(part) > 2
                and part in all_names_set
                and part not in enhanced
                and not any(k in part.lower() for k in skip_words)
            ):
                enhanced[part] = enhanced[existing_variant]

    return enhanced


def fill_identity_mappings(variant_to_canon: dict, unique_names: list,
                           skip_words: list = None) -> dict:
    """
    对 GPT 未覆盖的名字做 identity 映射或基于部分匹配的智能回填。
    原地修改并返回 variant_to_canon。
    """
    if skip_words is None:
        skip_words = []

    for n in unique_names:
        n_clean = clean_name(n)
        if not n_clean:
            continue

        # 尾部 's' → 单数匹配
        if n_clean.lower().endswith("s"):
            singular = n_clean[:-1]
            if singular in variant_to_canon:
                variant_to_canon[n_clean] = variant_to_canon[singular]
                continue

        # 已有映射就跳过
        if n_clean in variant_to_canon:
            continue

        # 检查是否应该映射到现有 canonical
        matched = False
        for canon in set(variant_to_canon.values()):
            if (
                n_clean in canon.split()
                or canon in n_clean.split()
                or n_clean == canon
            ):
                variant_to_canon[n_clean] = canon
                matched = True
                break

        # 无匹配 → identity 映射
        if not matched and not any(k in n_clean.lower() for k in skip_words):
            variant_to_canon[n_clean] = n_clean

    return variant_to_canon


def build_variants_map(variant_to_canon: dict) -> dict:
    """
    返回 canonical → [variants...]，给前端做高亮用。
    按长度降序排列，确保前端正则先匹配长名字。
    """
    canon_to_variants = defaultdict(set)
    for variant, canon in (variant_to_canon or {}).items():
        if not canon or not variant:
            continue
        canon_to_variants[canon].add(canon)
        canon_to_variants[canon].add(variant)

    out = {}
    for canon, vs in canon_to_variants.items():
        out[canon] = sorted(list(vs), key=lambda x: len(x), reverse=True)
    return out


# ═══════════════════════════════════════════════════
# GPT 名字规范化
# ═══════════════════════════════════════════════════

def _build_gpt_prompt(unique_names: list, is_short_text: bool) -> str:
    """根据文本长度构建不同的 prompt。"""
    if is_short_text:
        return f"""
You are an expert in literary text analysis.

You are given a list of PERSON entities automatically extracted from a SHORT STORY.
They may include:
- Character names (like "James Dillingham Young", "Della")
- Nicknames (like "Jim", "Dell")

Here is the extracted list (max 200 entries):
{json.dumps(unique_names, ensure_ascii=False)}

CRITICAL FOR SHORT STORIES:
- Be VERY CONSERVATIVE when merging names.
- Only merge names if you are ABSOLUTELY certain they refer to the same character.
- In short stories, different characters often have distinct names without many variants.
- DO NOT merge names like "Della" and "James" - they are clearly different characters.
- When in doubt, keep names separate rather than risk incorrect merging.

Your job:
1. Identify which names correspond to fictional characters from the story.
2. Merge name variants ONLY when you are certain they refer to the same character.
3. Exclude any non-character entities.
4. Output only valid JSON in this exact structure:

{{ "Canonical Character Name": ["variant1", "variant2", "variant3"] }}

Rules:
- Output must be a single valid JSON object.
- No markdown, no explanations, no comments, no backticks.
- Be conservative - better to have separate entries than incorrect merges.
"""
    else:
        return f"""
You are an expert in literary text analysis.

You are given a list of PERSON entities automatically extracted from a novel.
They may include:
- Character names (like "Elizabeth Bennet", "Mr. Darcy")
- Nicknames (like "Lizzy")
- Non-character entities (like "Jane Austen", "Project Gutenberg")

Here is the extracted list (max 200 entries):
{json.dumps(unique_names, ensure_ascii=False)}

Your job:
1. Identify which names correspond to fictional characters from the novel.
2. Merge all name variants that refer to the same character (for example: "Darcy", "Mr. Darcy", "Fitzwilliam Darcy" → "Mr. Darcy").
3. Exclude any of the following:
   - Author names
   - Publishers, editors, illustrators, and translators
   - Non-human entities or locations
   - Words like "Chapter", "Copyright", "Project Gutenberg"
4. Output only valid JSON in this exact structure:

{{ "Canonical Character Name": ["variant1", "variant2", "variant3"] }}

Rules:
- Output must be a single valid JSON object.
- No markdown, no explanations, no comments, no backticks.
- Keep only names of fictional characters that appear within the story.
"""


def _extract_response_text(resp) -> str:
    """从 OpenAI response 对象中稳健地提取文本。"""
    if hasattr(resp, "output_text") and resp.output_text:
        return resp.output_text.strip()

    try:
        if isinstance(resp.output, list):
            parts = []
            for item in resp.output:
                if isinstance(item, dict):
                    content = item.get("content") or item.get("text")
                    if isinstance(content, list):
                        for c in content:
                            if isinstance(c, dict) and "text" in c:
                                parts.append(c["text"])
                            elif isinstance(c, str):
                                parts.append(c)
                    elif isinstance(content, str):
                        parts.append(content)
            return "\n".join(parts).strip()
    except Exception:
        pass

    return str(resp)


def call_gpt_for_mapping(client, unique_names: list) -> dict:
    """
    调用 GPT 做名字归一化，返回解析后的 mapping dict。
    失败时返回 identity mapping。
    """
    is_short_text = len(unique_names) < 50  # 名字少 → 短文本
    prompt = _build_gpt_prompt(unique_names, is_short_text)

    try:
        print("🔹 Calling GPT model for name normalization...")
        resp = client.responses.create(
            model=GPT_MODEL,
            temperature=GPT_TEMPERATURE,
            input=[
                {"role": "system", "content": "Return valid JSON only."},
                {"role": "user", "content": prompt},
            ],
        )

        mapping_text = _extract_response_text(resp)
        print("🔹 GPT raw output preview (first 400 chars):")
        print(mapping_text[:400])

        # 清理 markdown 包裹
        cleaned = mapping_text
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
            cleaned = re.sub(r"\s*```$", "", cleaned)

        mapping = json.loads(cleaned)
        print("GPT mapping parsed successfully.")
        return mapping

    except Exception as e:
        print("🔸 GPT fallback: parsing failed or GPT error:", e)
        return {name: [name] for name in unique_names}


def apply_gpt_mapping(mapping: dict, skip_words: list = None) -> dict:
    """
    将 GPT 返回的 {canonical: [variants]} 转换为 {variant: canonical} 映射。
    """
    if skip_words is None:
        skip_words = SKIP_WORDS

    variant_to_canon = {}

    for canon, variants in mapping.items():
        canon_clean = clean_name(canon)
        if not canon_clean:
            continue
        if any(k in canon_clean.lower() for k in skip_words):
            continue

        # canonical 映射到自己
        variant_to_canon[canon_clean] = canon_clean

        if isinstance(variants, list):
            for v in variants:
                v_clean = clean_name(v)
                if v_clean and not any(k in v_clean.lower() for k in skip_words):
                    variant_to_canon[v_clean] = canon_clean

    return variant_to_canon
