#!/usr/bin/env python3
"""Generate the benchmark fixtures into <out-dir>.

  gen-fixtures.py <out-dir>

Writes doc-10k.md, doc-1m.md, doc-10m.md (sizes in bytes: 10,240, 1,048,576
and 10,485,760, give or take one block), doc-900k.md (the largest size the
rich editor opens) and doc-50p.docx (50 pages, a hard page break after each).
The text is deterministic, so every run and both apps see the same bytes.
"""
import os
import random
import sys
import zipfile
from xml.sax.saxutils import escape

WORDS = (
    "the of and to a in is that for it as was with be by on not he this are or his from at which but have an they "
    "you were her she there one all we their can has more when will would so if no what up out about who them do "
    "into some could time these two may then first any my now such like our over man me even most made after also "
    "did many before must through back years where much your way well down should because each just those people "
    "markdown document editor section table heading paragraph render native window frame latency search index"
).split()


def sentence(rng: random.Random) -> str:
    n = rng.randint(8, 22)
    words = [rng.choice(WORDS) for _ in range(n)]
    if rng.random() < 0.25:
        k = rng.randrange(n)
        words[k] = f"**{words[k]}**"
    if rng.random() < 0.2:
        k = rng.randrange(n)
        words[k] = f"*{words[k]}*"
    if rng.random() < 0.1:
        k = rng.randrange(n)
        words[k] = f"`{words[k]}`"
    s = " ".join(words)
    return s[0].upper() + s[1:] + "."


def block(rng: random.Random, i: int) -> str:
    kind = i % 12
    if kind == 0:
        return f"## Section {i // 12 + 1}: {rng.choice(WORDS)} {rng.choice(WORDS)}\n"
    if kind in (3, 9):
        return "\n".join(f"- {sentence(rng)}" for _ in range(rng.randint(3, 6))) + "\n"
    if kind == 6:
        rows = ["| Name | Value | Note |", "|---|---:|---|"]
        rows += [f"| {rng.choice(WORDS)} | {rng.randint(1, 9999)} | {rng.choice(WORDS)} {rng.choice(WORDS)} |" for _ in range(4)]
        return "\n".join(rows) + "\n"
    if kind == 10:
        body = "\n".join(f"let {rng.choice(WORDS)}_{j} = {rng.randint(0, 999)};" for j in range(rng.randint(3, 7)))
        return f"```rust\n{body}\n```\n"
    if kind == 7:
        return f"> {sentence(rng)} {sentence(rng)}\n"
    return " ".join(sentence(rng) for _ in range(rng.randint(3, 7))) + "\n"


def markdown(target: int, title: str) -> str:
    rng = random.Random(target)
    parts = [f"# {title}\n", "A Markie benchmark fixture. The same bytes go to both apps.\n"]
    size = sum(len(p) + 1 for p in parts)
    i = 0
    while size < target:
        b = block(rng, i)
        parts.append(b)
        size += len(b) + 1
        i += 1
    text = "\n".join(parts)
    return text[:target] if len(text) > target else text


def docx(path: str, pages: int) -> None:
    rng = random.Random(50)
    body = []
    for p in range(pages):
        body.append(f'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Page {p + 1}: {escape(rng.choice(WORDS))}</w:t></w:r></w:p>')
        for _ in range(6):
            text = escape(" ".join(sentence(rng).replace("*", "").replace("`", "") for _ in range(4)))
            body.append(f'<w:p><w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>')
        if p % 5 == 2:
            cells = "".join(f"<w:tc><w:p><w:r><w:t>{escape(rng.choice(WORDS))}</w:t></w:r></w:p></w:tc>" for _ in range(3))
            body.append("<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/></w:tblPr>" + f"<w:tr>{cells}</w:tr>" * 4 + "</w:tbl>")
        if p < pages - 1:
            body.append('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
    W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    document = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {W}><w:body>'
                + "".join(body)
                + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
                + "</w:body></w:document>")
    styles = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles {W}>'
              '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
              '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>'
              '<w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>')
    content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                     '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                     '<Default Extension="xml" ContentType="application/xml"/>'
                     '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                     '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
                     '</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            '</Relationships>')
    doc_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
                '</Relationships>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", document)
        z.writestr("word/styles.xml", styles)
        z.writestr("word/_rels/document.xml.rels", doc_rels)


def main() -> None:
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    for name, size in (("doc-10k", 10 * 1024), ("doc-900k", 900 * 1000), ("doc-1m", 1024 * 1024), ("doc-10m", 10 * 1024 * 1024)):
        with open(os.path.join(out, f"{name}.md"), "w", encoding="utf-8") as f:
            f.write(markdown(size, f"Markie bench {name}"))
    docx(os.path.join(out, "doc-50p.docx"), 50)
    for n in sorted(os.listdir(out)):
        print(f"{n}\t{os.path.getsize(os.path.join(out, n))}")


if __name__ == "__main__":
    main()
