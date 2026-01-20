import os, json, re
from typing import List, Dict
from fastapi import FastAPI, UploadFile
from fastapi.middleware.cors import CORSMiddleware
import spacy
import networkx as nx
from collections import defaultdict
from openai import OpenAI
from dotenv import load_dotenv   # ⬅ 新增这一行
load_dotenv()  # ⬅ 再新增这一行（一定要在 client = OpenAI(...) 之前）
from pydantic import BaseModel

# ---------------- 初始化 ----------------
app = FastAPI()
nlp = spacy.load("en_core_web_sm")
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class TextData(BaseModel):
    text: str

# 泛化黑名单 用于clean_name
BLACKLIST = {
    "project gutenberg", "gutenberg", "ebook", "e-text", "etext", "epub", "html", "ascii", "txt",
    "produced by", "transcribed by", "distributed proofreaders", "formatting", "release date",
    "license", "limited warranty", "liability", "copyright", "literary archive", "archive",
    "foundation", "internal revenue", "irs", "ein", "government",
    "preface", "editor", "translator", "illustrator", "publisher", "chapter", "send", "send:",
    "general information", "terms", "warranty", "possibility", "punitive", "liable", "direct",
    # 常见作者
    "o henry", "o. henry", "michael s hart", "project gutenberg literary archive foundation",
    "mark twain", "jane austen", "charles dickens", "william shakespeare",
    # 比喻or历史人物
    "solomon", "king solomon", "caesar", "napoleon", "homer"
}

# 前缀集合
HONORIFICS = {"mr", "mrs", "ms", "miss", "dr", "mme", "mlle", "sir", "lady", "lord", "master", "mx"}

# 用于在prompt中排除的词
SKIP_WORDS = ["copyright", "edition", "chapter", "preface", "project", "release", "translator", "gutenberg"]

def split_text_by_sentence(text):
    """按句子拆分"""
    text = re.sub(r'\s+', ' ', text)
    doc = nlp(text)
    return [sent.text.strip() for sent in doc.sents if len(sent.text.strip()) > 20]

def extract_persons(chunk):
    """提取句子中的人名"""
    doc = nlp(chunk)
    return [ent.text.strip() for ent in doc.ents if ent.label_ == "PERSON"]


# 处理名字
def clean_name(name: str) -> str:
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

    # honorific
    if parts[0].lower().strip(".") in HONORIFICS and len(parts) == 1:
        return ""

    # 重建名字
    name_cleaned = " ".join(p.capitalize() for p in parts)

    # 去掉后缀残留的词 例如 --but said
    name_cleaned = re.sub(r"\b(but|said|says|then|also)\b", "", name_cleaned, flags=re.IGNORECASE).strip()

    # 黑名单过滤
    lname = name_cleaned.lower()
    for bad in BLACKLIST:
        if bad in lname:
            return ""

    return name_cleaned



def clean_illustrations(text: str) -> str:
    """
    Remove Gutenberg illustration blocks such as:
    [Illustration: ...]
    [Illustration ...]
    [_Copyright 1894 by ...]
    """

    text = re.sub(
        r"\[.*?illustration.*?\]",
        "",
        text,
        flags=re.IGNORECASE | re.DOTALL
    )

    text = re.sub(
        r"\[_copyright.*?\]",
        "",
        text,
        flags=re.IGNORECASE | re.DOTALL
    )

    """text = re.sub(r"\[[^\]]{0,200}\]", " ", text)
    # Normalize whitespace
    text = re.sub(r"\n\s+\n", "\n\n", text)
    """

    return text


# ---------------- 章节拆分函数 ----------------
def split_into_chapters(text: str):
    if not text:
        return []

    # 标准化换行
    normalized = re.sub(r'\r\n', '\n', text)

    # 带捕获组的章节模式（这样 re.split 会保留章节标题）
    chapter_patterns = [
        r"(Chapter\s+\d+)",           # Chapter 1
        r"(CHAPTER\s+\d+)",           # CHAPTER 1
        r"(CHAPTER\s+[IVXLCDM]+\.?)", # CHAPTER I, CHAPTER II ...
    ]

    for pat in chapter_patterns:
        # 使用捕获组保留章节标题
        raw = re.split(pat, normalized, flags=re.MULTILINE | re.IGNORECASE)
        # raw 结构:
        # ["前言内容", "CHAPTER 1", "正文1", "CHAPTER 2", "正文2", ...]
        if len(raw) > 1:
            parts = []
            for i in range(1, len(raw), 2):
                title = raw[i].strip()                       # 标题
                body = raw[i + 1].strip() if i + 1 < len(raw) else ""  # 正文
                parts.append(title + "\n" + body)

            # 至少 5 章才算真正的章节结构
            if len(parts) >= 5:
                return parts

    # ---- 无明显章节标题时，按段落拆分 ----
    paragraphs = re.split(r"\n\s*\n+", normalized)
    paragraphs = [p.strip() for p in paragraphs if p.strip()]

    if len(paragraphs) <= 50:
        return paragraphs

    # 段落太多 → 合并成 ~50 段
    target = 50
    size = (len(paragraphs) + target - 1) // target
    merged = ["\n\n".join(paragraphs[i:i + size]) for i in range(0, len(paragraphs), size)]
    return merged


# ---------------- timeline函数 ----------------
def compute_timeline(chapters, variant_to_canon):
    """
    返回: { 'Mr Darcy': [count_ch1, count_ch2, ...], ... }
    这里按“canonical + 所有变体”的联合正则来统计每章出现次数。
    """

    # 先把 variant_to_canon 反转：canonical -> {variants...}
    from collections import defaultdict

    canon_to_variants = defaultdict(set)
    for variant, canon in variant_to_canon.items():
        canon_to_variants[canon].add(canon)    # canonical 自己也算一种写法
        canon_to_variants[canon].add(variant)  # 以及所有变体

    timeline = defaultdict(lambda: [0] * len(chapters))

    for idx, chapter_text in enumerate(chapters):
        # 将章节文本归一化（仿 clean_name）
        norm_text = re.sub(r"[^A-Za-z\s']", " ", chapter_text)
        norm_text = re.sub(r"\s+", " ", norm_text)

        # 对每个 canonical 统计：它的所有变体在本章中出现的总次数
        for canon, variants in canon_to_variants.items():
            # 为这个 canonical 构造一个联合正则：(Var1|Var2|...)
            pattern_parts = []
            for v in variants:
                # 把名字里的空格变成 \s+，允许多个空白（Mr Darcy / Mr   Darcy）
                v_regex = re.escape(v).replace(r"\ ", r"\s+")
                pattern_parts.append(v_regex)

            if not pattern_parts:
                continue

            pattern = re.compile(r"\b(?:%s)\b" % "|".join(pattern_parts),
                                 re.IGNORECASE)

            matches = pattern.findall(norm_text)
            timeline[canon][idx] = len(matches)
    print("Elizabeth timeline:", timeline.get("Elizabeth Bennet"))#console打印check
    return timeline


# ================== 以下为我新增的最小增量辅助函数 ==================
# 新增目的：
# 1) Timeline 交互(4)：点击某章时，需要后端能提供章节的 title/snippet（chapter card）
# 2) Timeline 交互(4)：点击某章时，需要能展示该角色在该章出现的“证据句”（mentions）
# 3) Context 交互(3)：edge context 需要带 chapters: [n]，前端才能显示 Chapter chips 跳转


def build_chapters_meta(chapters):
    """
    为每一章生成 metadata（给前端 Timeline 的 chapter card 用）
    统一使用阿拉伯数字作为章节编号（CHAPTER 1, CHAPTER 2, ...）
    snippet 使用该章节的第一段正文
    """
    meta = []

    for i, ch in enumerate(chapters, start=1):
        raw = (ch or "").strip()

        # 去掉标题行，只保留正文
        lines = raw.splitlines()
        body = "\n".join(lines[1:]).strip() if len(lines) > 1 else raw

        # 按空行切段，取第一段
        paras = [p.strip() for p in re.split(r"\n\s*\n+", body) if p.strip()]
        first_para = paras[0] if paras else ""

        snippet = re.sub(r"\s+", " ", first_para)

        meta.append({
            "index": i,
            "title": f"CHAPTER {i}",   # 永远是阿拉伯数字
            "snippet": snippet
        })

    return meta

def build_mentions(chapters, variant_to_canon, limit_per_chapter=None):
    """
    新增：为 Timeline 交互(4)生成“证据句”
    要求：显示该角色出现的“所有句子证据”
    做法：默认 limit_per_chapter=None 表示不限制；每章收集该角色出现的全部句子

    返回结构（JSON 的 key 需要字符串，所以章号用 str）：
    {
      "Elizabeth Bennet": {"1": ["sent1", "sent2", ...], "2": [...], ...},
      ...
    }

    参数：
    - limit_per_chapter: None 不限制；传 int 可限制每章最多多少条（当前需求：不限制）
    """
    mentions = defaultdict(lambda: defaultdict(list))

    for ci, chapter_text in enumerate(chapters, start=1):
        sents = split_text_by_sentence(chapter_text)

        for sent in sents:
            raw_persons = extract_persons(sent)
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
                if limit_per_chapter is None:
                    mentions[canon][str(ci)].append(sent)
                else:
                    if len(mentions[canon][str(ci)]) < int(limit_per_chapter):
                        mentions[canon][str(ci)].append(sent)

        # 新增：每章内去重（同一句可能因处理差异产生重复）
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

def build_sentence_chapter_index(chapters):
    """
    新增：把章节拆成句子，并记录每句属于哪一章（1-based）
    用途：让 build_cooccurrence_network 里的 contexts 记录 chapters:[n]（交互(3)）
    返回：
      sentences_all, sent_persons_all, chapter_ids
    """
    all_sents = []
    all_persons = []
    chapter_ids = []

    for ci, chapter_text in enumerate(chapters, start=1):
        sents = split_text_by_sentence(chapter_text)
        for sent in sents:
            raw_persons = extract_persons(sent)
            persons = []
            for p in raw_persons:
                p_clean = clean_name(p)
                if p_clean:
                    persons.append(p_clean)
            all_sents.append(sent)
            all_persons.append(persons)
            chapter_ids.append(ci)

    return all_sents, all_persons, chapter_ids

def build_variants_map(variant_to_canon):
    """
    ✅ 新增：返回 canonical -> [variants...]，给前端做高亮用
    结构：
    {
      "Elizabeth Bennet": ["Elizabeth Bennet", "Elizabeth", "Lizzy", ...],
      ...
    }
    """
    canon_to_variants = defaultdict(set)
    for variant, canon in (variant_to_canon or {}).items():
        if not canon or not variant:
            continue
        canon_to_variants[canon].add(canon)
        canon_to_variants[canon].add(variant)

    # 输出为 list，并按长度降序（前端 regex 更稳：先匹配长名字）
    out = {}
    for canon, vs in canon_to_variants.items():
        out[canon] = sorted(list(vs), key=lambda x: len(x), reverse=True)
    return out


# ---------------- 共用文本分析函数 ----------------
def process_text(text: str):
    text = clean_illustrations(text)
    skip_words = SKIP_WORDS

    print("🔹 Splitting sentences and extracting names...")
    sentences = split_text_by_sentence(text)
    all_names, sent_persons = [], []
    sent_persons = []

    for sent in sentences:
        raw_persons = extract_persons(sent)
        persons = []
        for p in raw_persons:
            p_clean = clean_name(p)
            if p_clean:
                persons.append(p_clean)
        if persons:
            sent_persons.append(persons)
            all_names.extend(persons)
        else:
            sent_persons.append([])

    unique_names = sorted(set(all_names))[:200]
    print(f"Extracted {len(unique_names)} candidate names.")
    # 检测是否为短文本
    is_short_text = len(text) < 20000  # 小于2万字符算短文本

    # 修改prompt，对短文本添加更严格的要求
    if is_short_text:
        prompt = f"""
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
        prompt = f"""
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

    # ---------------- GPT 角色聚合 ----------------
    try:
        print("🔹 Calling GPT model for name normalization...")
        resp = client.responses.create(
            model="gpt-4o-mini",
            temperature=0,
            input=[
                {"role": "system", "content": "Return valid JSON only."},
                {"role": "user", "content": prompt},
            ],
        )

        mapping_text = ""
        if hasattr(resp, "output_text") and resp.output_text:
            mapping_text = resp.output_text.strip()
        else:
            # Fallback: try to extract from resp.output or resp.get("output", ...)
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
                    mapping_text = "\n".join(parts).strip()
                else:
                    mapping_text = str(resp)
            except Exception:
                mapping_text = str(resp)
        print("🔹 GPT raw output preview (first 400 chars):")
        print(mapping_text[:400])

        # 解析 JSON
        cleaned = mapping_text
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
            cleaned = re.sub(r"\s*```$", "", cleaned)
        mapping = json.loads(cleaned)
        print("GPT mapping parsed successfully.")
    except Exception as e:
        print("🔸 GPT fallback: parsing failed or GPT error:", e)
        # 如果GPT失败 每个名字映射到自己
        mapping = {name: [name] for name in unique_names}

    # ---------------- 建立变体 -> canonical 映射（保证完整） ----------------
    variant_to_canon = {}

    # 写入GPT提供的mapping 包括canonical本身
    for canon, variants in mapping.items():
        canon_clean = clean_name(canon)
        if not canon_clean:
            continue
        # 忽略含skip_words的canonical
        if any(k in canon_clean.lower() for k in skip_words):
            continue
        # 把canonical映射到自己 保证canonical出现在mapping
        variant_to_canon[canon_clean] = canon_clean
        # 把变体映射到canonical
        if isinstance(variants, list):
            for v in variants:
                v_clean = clean_name(v)
                if v_clean and not any(k in v_clean.lower() for k in skip_words):
                    variant_to_canon[v_clean] = canon_clean

    # 只从现有的名字中提取部分匹配 不创建新名字
    def enhance_mapping(variant_to_canon, all_extracted_names):
        enhanced_mapping = variant_to_canon.copy()
        canonicals = list(set(enhanced_mapping.values()))
        all_names_set = set(all_extracted_names)  # 所有实际提取到的名字

        # 为每个已存在的名字变体 检查其部分是否也在提取的名字列表中
        for existing_variant in list(enhanced_mapping.keys()):
            parts = existing_variant.split()
            if len(parts) <= 1:
                continue

            # 检查每个部分是否独立存在于提取的名字中
            for part in parts:
                if (len(part) > 2 and  # 避免太短的匹配
                    part in all_names_set and
                    part not in enhanced_mapping and
                    not any(k in part.lower() for k in skip_words)):
                    # 将这个部分映射到同一个 canonical
                    enhanced_mapping[part] = enhanced_mapping[existing_variant]

        return enhanced_mapping

    variant_to_canon = enhance_mapping(variant_to_canon, unique_names)

    # 对unique_names中任何未被GPT映射的名字做identity映射
    for n in unique_names:
        n_clean = clean_name(n)
        if not n_clean:
            continue

        # 如果尾部是s尝试去掉再匹配
        if n_clean.lower().endswith("s"):
            singular = n_clean[:-1]
            if singular in variant_to_canon:
                variant_to_canon[n_clean] = variant_to_canon[singular]
                continue

        # 如果名字已经在映射中就跳过
        if n_clean in variant_to_canon:
            continue

        # 检查是否应该映射到现有的 canonical
        matched = False
        for canon in set(variant_to_canon.values()):
            # 检查n_clean是否是canon的一部分 或者canon是n_clean的一部分
            if (n_clean in canon.split() or canon in n_clean.split() or
                n_clean == canon):
                variant_to_canon[n_clean] = canon
                matched = True
                break

        # 如果没有匹配到任何现有的 做identity映射
        if not matched and not any(k in n_clean.lower() for k in skip_words):
            variant_to_canon[n_clean] = n_clean


    # ---------------- 用 canonical 名称构建共现网络 ----------------
    def build_cooccurrence_network(sentences, sent_persons, variant_to_canon, sentence_chapters=None):
        G = nx.Graph()
        cooccurrence_texts = defaultdict(list)

        # ✅ 新增：如果没有提供 sentence -> chapter 映射，则全部当作第1章（保持向后兼容）
        if sentence_chapters is None:
            sentence_chapters = [1] * len(sentences)

        # 根据句子数量动态调整阈值
        total_sentences = len(sentences)
        if total_sentences < 100:  # 短文本
            min_count_threshold = 1  # 出现1次就保留
        elif total_sentences < 500:  # 中等长度
            min_count_threshold = 2  # 出现2次就保留
        else:  # 长文本
            min_count_threshold = 5  # 原始阈值

        for sent, persons, ch_idx in zip(sentences, sent_persons, sentence_chapters):
            # 计算文本长度，动态调整上下文大小
            text_length = len(' '.join(sentences))
            is_long_text = text_length > 50000  # 50K字符以上算长文本
            # 动态设置上下文长度
            if is_long_text:
                # 长文本：可以保留较长上下文（400字符）
                context_length = 400
            else:
                # 短文本：使用较短上下文，避免场景混合
                context_length = 200

            # 将句子中提取的每个名字替换成canonical 若没有canonical则跳过
            canon_list = []
            for p in persons:
                p_clean = clean_name(p)
                if not p_clean:
                    continue
                canon_name = variant_to_canon.get(p_clean)
                if canon_name:
                    canon_list.append(canon_name)
            canon_list = list(set(canon_list))  # 去重

            if not canon_list:
                continue

            # 增加节点计数 使用canonical name
            for a in canon_list:
                if a in G.nodes:
                    G.nodes[a]["count"] += 1
                else:
                    G.add_node(a, count=1)

            # 增加边并保存上下文句子
            for i in range(len(canon_list)):
                for j in range(i + 1, len(canon_list)):
                    a, b = canon_list[i], canon_list[j]
                    if G.has_edge(a, b):
                        G[a][b]["weight"] += 1
                    else:
                        G.add_edge(a, b, weight=1)

                    # use sorted key so "A|B" and "B|A" map same
                    key = "|".join(sorted([a, b]))

                    # ✅ 新增：contexts 由 string 改为 {text, chapters:[n]}
                    # 目的：前端 Contexts 面板可以显示 Chapter chips（交互(3)）
                    if len(cooccurrence_texts[key]) < 5:  # 限制上下文条数
                        cooccurrence_texts[key].append({
                            "text": sent[:context_length],
                            "chapters": [int(ch_idx)]
                        })

        # 使用动态阈值过滤节点
        nodes_to_keep = [n for n in G.nodes if G.nodes[n].get("count", 0) >= min_count_threshold]
        print(f"Filter threshold: {min_count_threshold}, Nodes before filtering: {len(G.nodes)}, after: {len(nodes_to_keep)}")

        # 创建子图
        G_filtered = G.subgraph(nodes_to_keep).copy()

        all_nodes = list(G_filtered.nodes)
        node_set = set(all_nodes)

        # links：只保留两端都在node_set的边
        links = []
        for u, v, data in G.edges(data=True):
            if u in node_set and v in node_set and data.get("weight", 0) > 0:
                links.append({"source": u, "target": v, "value": int(data["weight"])})

        # nodes：输出所有在node_set中的节点 按count排序（大到小）
        nodes = [{"id": n, "value": int(G.nodes[n].get("count", 1))} for n in all_nodes]
        nodes = sorted(nodes, key=lambda x: x["value"], reverse=True)

        print(f"Final Network: {len(nodes)} nodes, {len(links)} edges.")

        # ✅ 原来这里算了 filtered_contexts 但没用到；我保留你同学原意：只返回过滤后的 contexts
        filtered_contexts = {}
        for key, contexts in cooccurrence_texts.items():
            chars = key.split("|")
            if len(chars) == 2 and chars[0] in node_set and chars[1] in node_set:
                filtered_contexts[key] = contexts

        return {"nodes": nodes, "links": links, "contexts": filtered_contexts}

    # 在这里调用章节拆分函数
    chapters = split_into_chapters(text)
    if not chapters:
        chapters = [text]

    # 新增：章节->句子索引（为了 contexts 里带章节号，交互(3)）
    sentences2, sent_persons2, chapter_ids = build_sentence_chapter_index(chapters)

    # 共现网络用“带章节号的句子”，从而 contexts 自动带 chapters:[n]
    result = build_cooccurrence_network(sentences2, sent_persons2, variant_to_canon, chapter_ids)

    # 计算 timeline
    timeline = compute_timeline(chapters, variant_to_canon)

    # 把 timeline 信息加入结果返回
    result["timeline"] = timeline
    result["chapter_count"] = len(chapters)

    # 新增：给前端 Timeline chapter card 用（交互(4)）
    result["chapters_meta"] = build_chapters_meta(chapters)

    # 新增：给前端 Timeline chapter card 的“证据句”用（交互(4)）
    result["mentions"] = build_mentions(chapters, variant_to_canon, limit_per_chapter=None)

    # ✅ 新增：给前端高亮人名用（canonical -> variants）
    result["variants"] = build_variants_map(variant_to_canon)

    return result


# ---------------- 主分析接口 ----------------
@app.post("/analyze")
async def analyze(file: UploadFile):
    text = (await file.read()).decode("utf-8", errors="ignore")
    result = process_text(text)
    return result

@app.post("/analyze-text")
async def analyze_text(data: TextData):
    text = data.text
    result = process_text(text)
    return result

@app.get("/ping")
async def ping():
    return {"message": "pong", "key_loaded": bool(os.getenv("OPENAI_API_KEY"))}
