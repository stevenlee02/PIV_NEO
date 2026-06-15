"""
共现网络构建 —— 从句子+人物列表生成节点、边、上下文。
从 app.py 的嵌套函数 build_cooccurrence_network 提取。
"""
from collections import defaultdict
import networkx as nx
from normalizer import clean_name
from config import (
    DYNAMIC_THRESHOLDS,
    CONTEXT_LIMIT,
    CONTEXT_LENGTH_SHORT,
    CONTEXT_LENGTH_LONG,
    LONG_TEXT_THRESHOLD,
)


def build_cooccurrence_network(
    sentences: list,
    sent_persons: list,
    variant_to_canon: dict,
    sentence_chapters: list = None,
) -> dict:
    """
    构建角色共现网络。

    参数:
        sentences: 句子列表
        sent_persons: 每句提取的人名列表 (raw, 未清洗)
        variant_to_canon: {variant: canonical} 映射
        sentence_chapters: 每句所属章节号 (1-based)，None 则全部视为第1章

    返回:
        {"nodes": [...], "links": [...], "contexts": {...}}
    """
    G = nx.Graph()
    cooccurrence_texts = defaultdict(list)

    if sentence_chapters is None:
        sentence_chapters = [1] * len(sentences)

    # 动态阈值
    total_sentences = len(sentences)
    min_count_threshold = 5  # 默认
    for max_sents, thresh in DYNAMIC_THRESHOLDS:
        if total_sentences < max_sents:
            min_count_threshold = thresh
            break

    text_length = len(" ".join(sentences))
    is_long_text = text_length > LONG_TEXT_THRESHOLD
    context_length = CONTEXT_LENGTH_LONG if is_long_text else CONTEXT_LENGTH_SHORT

    for sent, persons, ch_idx in zip(sentences, sent_persons, sentence_chapters):
        # 名字 → canonical
        canon_list = []
        for p in persons:
            p_clean = clean_name(p)
            if not p_clean:
                continue
            canon_name = variant_to_canon.get(p_clean)
            if canon_name:
                canon_list.append(canon_name)
        canon_list = list(set(canon_list))

        if not canon_list:
            continue

        # 节点计数
        for a in canon_list:
            if a in G.nodes:
                G.nodes[a]["count"] += 1
            else:
                G.add_node(a, count=1)

        # 边 + 上下文
        for i in range(len(canon_list)):
            for j in range(i + 1, len(canon_list)):
                a, b = canon_list[i], canon_list[j]
                if G.has_edge(a, b):
                    G[a][b]["weight"] += 1
                else:
                    G.add_edge(a, b, weight=1)

                key = "|".join(sorted([a, b]))
                if len(cooccurrence_texts[key]) < CONTEXT_LIMIT:
                    cooccurrence_texts[key].append({
                        "text": sent[:context_length],
                        "chapters": [int(ch_idx)],
                    })

    # 按阈值过滤节点
    nodes_to_keep = [
        n for n in G.nodes
        if G.nodes[n].get("count", 0) >= min_count_threshold
    ]
    print(
        f"Filter threshold: {min_count_threshold}, "
        f"Nodes before: {len(G.nodes)}, after: {len(nodes_to_keep)}"
    )

    G_filtered = G.subgraph(nodes_to_keep).copy()
    all_nodes = list(G_filtered.nodes)
    node_set = set(all_nodes)

    # links
    links = []
    for u, v, data in G.edges(data=True):
        if u in node_set and v in node_set and data.get("weight", 0) > 0:
            links.append({
                "source": u,
                "target": v,
                "value": int(data["weight"]),
            })

    # nodes（按 count 降序）
    nodes = [
        {"id": n, "value": int(G.nodes[n].get("count", 1))}
        for n in all_nodes
    ]
    nodes = sorted(nodes, key=lambda x: x["value"], reverse=True)

    print(f"Final Network: {len(nodes)} nodes, {len(links)} edges.")

    # 过滤 contexts
    filtered_contexts = {}
    for key, contexts in cooccurrence_texts.items():
        chars = key.split("|")
        if len(chars) == 2 and chars[0] in node_set and chars[1] in node_set:
            filtered_contexts[key] = contexts

    return {"nodes": nodes, "links": links, "contexts": filtered_contexts}
