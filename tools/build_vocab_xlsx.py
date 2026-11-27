# -*- coding: utf-8 -*-
"""把《高中核心词汇1000+高考超纲词.xlsx》转成前端可直接 import 的 JS 模块。

用法：
    python tools/build_vocab_xlsx.py [xlsx 路径] [输出路径]

默认读取仓库根目录的 xlsx，输出 public/js/vocab1000.js。
词表更新后重跑本脚本即可，不要手改生成的文件。
"""

import json
import os
import sys

try:
    import openpyxl
except ImportError:  # pragma: no cover
    sys.exit("需要 openpyxl：pip install openpyxl")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SRC = os.path.join(ROOT, "高中核心词汇1000+高考超纲词.xlsx")
DEFAULT_OUT = os.path.join(ROOT, "public", "js", "vocab1000.js")

SHEETS = [("VOCAB_CORE", "核心1000词"), ("VOCAB_EXTRA", "超纲扩充词")]


def clean_phonetic(value):
    s = str(value or "").strip()
    if s.startswith("/") and s.endswith("/") and len(s) > 2:
        s = s[1:-1].strip()
    return s


def clean_meaning(value):
    s = " ".join(str(value or "").replace("\r", " ").replace("\n", " ").split())
    return s


def read_sheet(ws):
    rows = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not row or not row[0]:
            continue
        term = " ".join(str(row[0]).split())
        phonetic = clean_phonetic(row[2])
        meaning = clean_meaning(row[3])
        if term:
            rows.append([term, phonetic, meaning])
    return rows


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    out = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    if not os.path.exists(src):
        sys.exit(f"找不到词表文件：{src}")

    wb = openpyxl.load_workbook(src, data_only=True)
    parts = [
        "// 由 tools/build_vocab_xlsx.py 从《高中核心词汇1000+高考超纲词.xlsx》生成，请勿手改。",
        "// 每项：[单词/短语, 音标, 中文释义]。词表更新后重跑脚本即可。",
        "",
    ]
    total = 0
    for name, sheet in SHEETS:
        if sheet not in wb.sheetnames:
            sys.exit(f"缺少工作表：{sheet}")
        rows = read_sheet(wb[sheet])
        total += len(rows)
        body = ",\n".join(json.dumps(r, ensure_ascii=False) for r in rows)
        parts.append(f"export const {name} = [\n{body}\n];\n")

    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(parts))
    print(f"已生成 {out}：{total} 条（核心 {len(read_sheet(wb[SHEETS[0][1]]))} / 超纲 {len(read_sheet(wb[SHEETS[1][1]]))}）")


if __name__ == "__main__":
    main()
