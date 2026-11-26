#!/usr/bin/env python3
"""Write a small made-up Word document for the Recent and Cloud scenes.

    docx-fixture.py <out.docx>

Only the parts Word needs: a title and a few paragraphs, all invented here.
"""
import sys
import zipfile

PARAS = [
    ("Title", "Offer letter"),
    (None, "Dear Sam,"),
    (None, "We are glad to offer you the role of designer at the studio, starting on the first Monday of next month."),
    (None, "Your first two weeks follow the field guide. Your buddy will meet you at the front desk at nine."),
    (None, "Please sign and return a copy by Friday. We look forward to working with you."),
    (None, "Kind regards,"),
    (None, "The studio"),
]

def para(style, text):
    props = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    return f"<w:p>{props}<w:r><w:t xml:space=\"preserve\">{text}</w:t></w:r></w:p>"

DOC = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + "".join(para(s, t) for s, t in PARAS)
    + "</w:body></w:document>"
)
TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    "</Types>"
)
RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    "</Relationships>"
)

with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", TYPES)
    z.writestr("_rels/.rels", RELS)
    z.writestr("word/document.xml", DOC)
