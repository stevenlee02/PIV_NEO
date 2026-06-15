"""
所有可配置的常量集中管理。
"""

# ---------------- CORS 跨域配置 ----------------
CORS_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
]

# ---------------- NLP / spaCy 配置 ----------------
SPACY_MODEL = "en_core_web_sm"
MIN_SENTENCE_LENGTH = 20  # 过滤掉太短的句子

# ---------------- 名字清洗 ----------------
HONORIFICS = {
    "mr", "mrs", "ms", "miss", "dr", "mme", "mlle",
    "sir", "lady", "lord", "master", "mx",
}

BLACKLIST = {
    # 电子书平台 & 元数据
    "project gutenberg", "gutenberg", "ebook", "e-text", "etext",
    "epub", "html", "ascii", "txt",
    "produced by", "transcribed by", "distributed proofreaders",
    "formatting", "release date",
    "license", "limited warranty", "liability", "copyright",
    "literary archive", "archive",
    "foundation", "internal revenue", "irs", "ein", "government",
    "preface", "editor", "translator", "illustrator", "publisher",
    "chapter", "send", "send:",
    "general information", "terms", "warranty", "possibility",
    "punitive", "liable", "direct",
    # 常见作者
    "o henry", "o. henry", "michael s hart",
    "project gutenberg literary archive foundation",
    "mark twain", "jane austen", "charles dickens", "william shakespeare",
    # 比喻 / 历史人物
    "solomon", "king solomon", "caesar", "napoleon", "homer",
}

# GPT prompt 中要排除的关键词
SKIP_WORDS = [
    "copyright", "edition", "chapter", "preface",
    "project", "release", "translator", "gutenberg",
]

# ---------------- GPT 配置 ----------------
GPT_MODEL = "gpt-4o-mini"
GPT_TEMPERATURE = 0
SHORT_TEXT_THRESHOLD = 20_000   # < 2 万字符算短文本
MAX_UNIQUE_NAMES = 200          # 最多发送给 GPT 的名字数

# ---------------- 章节拆分配置 ----------------
MIN_CHAPTERS_TO_RECOGNIZE = 5   # 至少匹配到 5 章才算章节结构
MAX_PARAGRAPH_CHUNKS = 50       # 无章节结构时，段落合并的目标数量

# ---------------- 共现网络配置 ----------------
# (句子数上限, 最低出现次数阈值)
DYNAMIC_THRESHOLDS = [
    (100, 1),           # < 100 句：出现 1 次就保留
    (500, 2),           # < 500 句：出现 2 次保留
    (float("inf"), 5),  # 其他：出现 5 次保留
]

CONTEXT_LIMIT = 5            # 每对角色最多保留几句共现上下文
CONTEXT_LENGTH_SHORT = 200   # 短文上下文截取长度
CONTEXT_LENGTH_LONG = 400    # 长文上下文截取长度
LONG_TEXT_THRESHOLD = 50_000 # > 5 万字符算长文本
