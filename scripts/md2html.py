"""見出し・表・箇条書き・強調・インラインコード・リンク・水平線だけを扱う最小の変換。

`docs/questions.md` が使っている書式に合わせてある。コードブロックは入っていない。
"""
import html
import re
import sys


def inline(t: str) -> str:
    t = html.escape(t)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    t = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", t)
    t = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"<a href='\2'>\1</a>", t)
    return t


def convert(md: str) -> str:
    out, i = [], 0
    lines = md.split("\n")
    while i < len(lines):
        line = lines[i]

        if re.match(r"^---+$", line.strip()):
            out.append("<hr>")
            i += 1
            continue

        m = re.match(r"^(#{1,6}) (.*)$", line)
        if m:
            n = len(m.group(1))
            out.append(f"<h{n}>{inline(m.group(2))}</h{n}>")
            i += 1
            continue

        # 表。2 行目が区切りなら表として読む
        if line.startswith("|") and i + 1 < len(lines) and re.match(r"^\|[\s:|-]+\|$", lines[i + 1]):
            cells = lambda s: [c.strip() for c in s.strip().strip("|").split("|")]
            head = cells(line)
            i += 2
            body = []
            while i < len(lines) and lines[i].startswith("|"):
                body.append(cells(lines[i]))
                i += 1
            out.append("<table><thead><tr>"
                       + "".join(f"<th>{inline(c)}</th>" for c in head)
                       + "</tr></thead><tbody>"
                       + "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in body)
                       + "</tbody></table>")
            continue

        m = re.match(r"^(\d+)\. (.*)$", line)
        if m:
            start = m.group(1)
            items = []
            while i < len(lines) and re.match(r"^\d+\. ", lines[i]):
                item = re.sub(r"^\d+\. ", "", lines[i])
                i += 1
                while i < len(lines) and lines[i].startswith("   ") and lines[i].strip():
                    item += " " + lines[i].strip()
                    i += 1
                items.append(item)
            out.append(f"<ol start='{start}'>" + "".join(f"<li>{inline(x)}</li>" for x in items) + "</ol>")
            continue

        if line.startswith("- "):
            items = []
            while i < len(lines) and lines[i].startswith("- "):
                item = lines[i][2:]
                i += 1
                while i < len(lines) and lines[i].startswith("  ") and lines[i].strip():
                    item += " " + lines[i].strip()
                    i += 1
                items.append(item)
            out.append("<ul>" + "".join(f"<li>{inline(x)}</li>" for x in items) + "</ul>")
            continue

        if not line.strip():
            i += 1
            continue

        # 段落。空行まで continuation を繋ぐ
        para = [line]
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#{1,6} |\||- |\d+\. |---+$)", lines[i]):
            para.append(lines[i])
            i += 1
        out.append(f"<p>{inline(' '.join(s.strip() for s in para))}</p>")

    return "\n".join(out)


if __name__ == "__main__":
    print(convert(open(sys.argv[1], encoding="utf-8").read()))
