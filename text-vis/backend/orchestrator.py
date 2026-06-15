"""
编排器 —— 串联整个文本分析流程。
所有核心逻辑集中在此，HTTP 层只负责接收请求并调用本模块。
"""
from config import SKIP_WORDS, MAX_UNIQUE_NAMES, SHORT_TEXT_THRESHOLD
from text_utils import clean_illustrations, split_text_by_sentence, extract_persons
from normalizer import (
    clean_name,
    enhance_mapping,
    fill_identity_mappings,
    build_variants_map,
    call_gpt_for_mapping,
    apply_gpt_mapping,
)
from network import build_cooccurrence_network
from analysis import (
    split_into_chapters,
    compute_timeline,
    build_chapters_meta,
    build_sentence_chapter_index,
    build_mentions,
)


def process_text(text: str, nlp, client) -> dict:
    """
    完整分析管线：文本 → 结构化分析结果。
    可在任何地方独立调用，方便单独调试。
    """
    # ── 1. 文本清理 ──
    text = clean_illustrations(text)
    skip_words = SKIP_WORDS

    # ── 2. 句子拆分 & 名字提取 ──
    print("🔹 Splitting sentences and extracting names...")
    sentences = split_text_by_sentence(text, nlp)
    all_names = []
    sent_persons = []

    for sent in sentences:
        raw_persons = extract_persons(sent, nlp)
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

    unique_names = sorted(set(all_names))[:MAX_UNIQUE_NAMES]
    print(f"Extracted {len(unique_names)} candidate names.")

    # ── 3. GPT 名字规范化 ──
    mapping = call_gpt_for_mapping(client, unique_names)

    # ── 4. 建立 variant → canonical 映射 ──
    variant_to_canon = apply_gpt_mapping(mapping, skip_words)
    variant_to_canon = enhance_mapping(variant_to_canon, unique_names, skip_words)
    variant_to_canon = fill_identity_mappings(variant_to_canon, unique_names, skip_words)

    # ── 5. 章节拆分 ──
    chapters = split_into_chapters(text)
    if not chapters:
        chapters = [text]

    # ── 6. 句子→章节索引 & 共现网络 ──
    sents_idx, persons_idx, chapter_ids = build_sentence_chapter_index(chapters, nlp)
    result = build_cooccurrence_network(sents_idx, persons_idx, variant_to_canon, chapter_ids)

    # ── 7. 时间线 ──
    timeline = compute_timeline(chapters, variant_to_canon)
    result["timeline"] = timeline
    result["chapter_count"] = len(chapters)

    # ── 8. 章节元数据 & 证据句 & 变体表 ──
    result["chapters_meta"] = build_chapters_meta(chapters)
    result["mentions"] = build_mentions(chapters, variant_to_canon, nlp)
    result["variants"] = build_variants_map(variant_to_canon)

    return result
