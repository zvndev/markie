//! Bounded inline raster pictures (ECMA-376 sections 20 and 21, W3C PNG chunks,
//! JPEG marker framing). Ported from `docx-media.ts`. SVG and HTML are never
//! executed and linked pictures are never fetched.

use super::State;
use super::edit::*;
use super::parts::{DOCX_R, DOCX_R_STRICT, DOCX_REL, append_docx_xml, declare_docx_relationship_part, docx_part, docx_part_source, docx_relationships_part, resolve_relative};
use crate::error::Result;
use crate::model::{ImageInput, ImageType, InsertAt, js_number, js_round};
use crate::xml::{XMLNS_NAMESPACE, XmlElement, parse_xml, xml_attribute, xml_attribute_text, xml_descendants};
use crate::zip::zip_crc32;

const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;

fn bad(message: &str) -> crate::error::OfficeError {
    invalid("invalid-image", message)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bitmap {
    pub width: u32,
    pub height: u32,
}

fn dimensions(width: u32, height: u32) -> Result<Bitmap> {
    if width == 0 || height == 0 || width > 16384 || height > 16384 || width as u64 * height as u64 > 32_000_000 {
        return Err(bad("Image dimensions exceed the safe raster limit."));
    }
    Ok(Bitmap { width, height })
}

/// Structural framing, CRC and pixel budgets; not a replacement raster decoder.
pub fn inspect_docx_bitmap(input: &[u8], kind: ImageType) -> Result<Bitmap> {
    if input.len() < 16 || input.len() > MAX_IMAGE_BYTES {
        return Err(bad("Image exceeds its byte limits."));
    }
    let be32 = |at: usize| u32::from_be_bytes([input[at], input[at + 1], input[at + 2], input[at + 3]]);
    let be16 = |at: usize| u16::from_be_bytes([input[at], input[at + 1]]) as u32;
    if kind == ImageType::Png {
        if input[..8] != [137, 80, 78, 71, 13, 10, 26, 10] {
            return Err(bad("PNG signature is invalid."));
        }
        let mut cursor = 8;
        let mut image: Option<Bitmap> = None;
        let (mut idat, mut idat_ended, mut palette, mut indexed) = (false, false, false, false);
        let mut chunks = 0;
        while cursor + 12 <= input.len() {
            chunks += 1;
            if chunks > 2048 {
                return Err(bad("Image contains too many PNG chunks."));
            }
            let size = be32(cursor) as usize;
            let end = cursor + 12 + size;
            if end > input.len() {
                return Err(bad("Truncated PNG chunk."));
            }
            let kind = &input[cursor + 4..cursor + 8];
            if !kind.iter().all(u8::is_ascii_alphabetic) || zip_crc32(&input[cursor + 4..cursor + 8 + size]) != be32(cursor + 8 + size) {
                return Err(bad("PNG chunk integrity check failed."));
            }
            if chunks == 1 && kind != b"IHDR" {
                return Err(bad("PNG must begin with IHDR."));
            }
            match kind {
                b"IHDR" => {
                    if image.is_some() || size != 13 {
                        return Err(bad("Invalid or repeated PNG header."));
                    }
                    image = Some(dimensions(be32(cursor + 8), be32(cursor + 12))?);
                    let (depth, color) = (input[cursor + 16], input[cursor + 17]);
                    let allowed: &[u8] = match color {
                        0 => &[1, 2, 4, 8, 16],
                        2 | 4 | 6 => &[8, 16],
                        3 => &[1, 2, 4, 8],
                        _ => &[],
                    };
                    if !allowed.contains(&depth) || input[cursor + 18] != 0 || input[cursor + 19] != 0 || input[cursor + 20] > 1 {
                        return Err(bad("Unsupported PNG header."));
                    }
                    indexed = color == 3;
                }
                b"PLTE" => {
                    if idat || palette || size == 0 || size > 768 || size % 3 != 0 {
                        return Err(bad("Invalid PNG palette."));
                    }
                    palette = true;
                }
                b"IDAT" => {
                    if idat_ended || (indexed && !palette) {
                        return Err(bad("Invalid PNG data ordering."));
                    }
                    idat = true;
                }
                b"IEND" => {
                    if size != 0 || end != input.len() || !idat || image.is_none() {
                        return Err(bad("Invalid PNG end record."));
                    }
                    return Ok(image.unwrap());
                }
                _ => {
                    if idat {
                        idat_ended = true;
                    }
                    if kind[0].is_ascii_uppercase() || [b"acTL", b"fcTL", b"fdAT"].iter().any(|k| *k == kind) {
                        return Err(bad("Unknown critical or animated PNG chunks are unsupported."));
                    }
                }
            }
            cursor = end;
        }
        return Err(bad("PNG end record is missing."));
    }
    let n = input.len();
    if input[0] != 0xff || input[1] != 0xd8 || input[n - 2] != 0xff || input[n - 1] != 0xd9 {
        return Err(bad("JPEG signature is invalid."));
    }
    let mut cursor = 2;
    let mut image: Option<Bitmap> = None;
    let mut markers = 0;
    while cursor + 4 <= n {
        markers += 1;
        if markers > 2048 || input[cursor] != 0xff {
            return Err(bad("Invalid JPEG marker framing."));
        }
        cursor += 1;
        while cursor < n && input[cursor] == 0xff {
            cursor += 1;
        }
        let marker = *input.get(cursor).unwrap_or(&0);
        cursor += 1;
        if [0, 0xd8, 0xd9, 0x01].contains(&marker) || (0xd0..=0xd7).contains(&marker) {
            return Err(bad("Unexpected JPEG marker."));
        }
        let length = if cursor + 2 <= n { be16(cursor) as usize } else { 0 };
        if length < 2 || cursor + length > n - 2 {
            return Err(bad("Truncated JPEG segment."));
        }
        if [0xc0, 0xc1, 0xc2].contains(&marker) {
            if image.is_some() || length < 8 || input[cursor + 2] != 8 {
                return Err(bad("Unsupported JPEG frame."));
            }
            image = Some(dimensions(be16(cursor + 5), be16(cursor + 3))?);
        } else if (0xc3..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
            return Err(bad("Unsupported JPEG frame encoding."));
        }
        if marker == 0xda {
            // Entropy decoding belongs to the platform decoder.
            return image.ok_or_else(|| bad("JPEG scan has no supported frame."));
        }
        cursor += length;
    }
    Err(bad("JPEG scan is missing."))
}

struct Ns {
    a: String,
    wp: String,
    pic: String,
    r: &'static str,
}
fn namespaces(word: &str) -> Ns {
    let strict = word.contains("purl.oclc.org");
    let base = if strict { "http://purl.oclc.org/ooxml/drawingml/" } else { "http://schemas.openxmlformats.org/drawingml/2006/" };
    Ns { a: format!("{base}main"), wp: format!("{base}wordprocessingDrawing"), pic: format!("{base}picture"), r: if strict { DOCX_R_STRICT } else { DOCX_R } }
}

fn make_inline(namespace: &str, relationship_id: &str, drawing_id: &str, width: f64, height: f64, alt: &str) -> Result<String> {
    let ns = namespaces(namespace);
    let (cx, cy) = (js_number(js_round(width * 12700.0)), js_number(js_round(height * 12700.0)));
    let alt = xml_attribute_text(alt)?;
    Ok(format!(
        "<w:r xmlns:w=\"{namespace}\" xmlns:wp=\"{wp}\" xmlns:a=\"{a}\" xmlns:pic=\"{pic}\" xmlns:r=\"{r}\"><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\"><wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:docPr id=\"{drawing_id}\" name=\"Picture {drawing_id}\" descr=\"{alt}\"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri=\"{pic}\"><pic:pic><pic:nvPicPr><pic:cNvPr id=\"{drawing_id}\" name=\"Picture {drawing_id}\"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed=\"{relationship_id}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>",
        wp = ns.wp,
        a = ns.a,
        pic = ns.pic,
        r = ns.r
    ))
}

/// Bounded inline-picture grammar. Keys are "prefix:name"; prefixed attributes are namespaced.
fn picture_rule(key: &str) -> Option<(&'static [&'static str], &'static [&'static str])> {
    Some(match key {
        "wp:inline" => (&["wp:extent", "wp:effectExtent", "wp:docPr", "wp:cNvGraphicFramePr", "a:graphic"], &["distT", "distB", "distL", "distR", "wp14:anchorId", "wp14:editId"]),
        "wp:extent" => (&[], &["cx", "cy"]),
        "wp:effectExtent" => (&[], &["l", "t", "r", "b"]),
        "wp:docPr" => (&[], &["id", "name", "descr", "title", "hidden"]),
        "wp:cNvGraphicFramePr" => (&["a:graphicFrameLocks"], &[]),
        "a:graphicFrameLocks" => (&[], &["noChangeAspect", "noGrp", "noDrilldown", "noSelect", "noMove", "noResize"]),
        "a:graphic" => (&["a:graphicData"], &[]),
        "a:graphicData" => (&["pic:pic"], &["uri"]),
        "pic:pic" => (&["pic:nvPicPr", "pic:blipFill", "pic:spPr"], &[]),
        "pic:nvPicPr" => (&["pic:cNvPr", "pic:cNvPicPr"], &[]),
        "pic:cNvPr" => (&[], &["id", "name", "descr", "title", "hidden"]),
        "pic:cNvPicPr" => (&["a:picLocks"], &["preferRelativeResize"]),
        "a:picLocks" => (&[], &["noGrp", "noSelect", "noRot", "noChangeAspect", "noMove", "noResize", "noEditPoints", "noAdjustHandles", "noChangeArrowheads", "noChangeShapeType", "noCrop"]),
        "pic:blipFill" => (&["a:blip", "a:srcRect", "a:stretch"], &["dpi", "rotWithShape"]),
        "a:blip" => (&["a:extLst"], &["r:embed", "cstate"]),
        "a:extLst" => (&["a:ext"], &[]),
        "a:ext" => (&["a14:useLocalDpi", "asvg:svgBlip"], &["uri", "cx", "cy"]),
        "a14:useLocalDpi" => (&[], &["val"]),
        "asvg:svgBlip" => (&[], &["r:embed"]),
        "a:srcRect" => (&[], &["l", "t", "r", "b"]),
        "a:stretch" => (&["a:fillRect"], &[]),
        "a:fillRect" => (&[], &["l", "t", "r", "b"]),
        "pic:spPr" => (&["a:xfrm", "a:prstGeom", "a:noFill", "a:solidFill", "a:ln"], &["bwMode"]),
        "a:xfrm" => (&["a:off", "a:ext"], &["rot", "flipH", "flipV"]),
        "a:off" => (&[], &["x", "y"]),
        "a:prstGeom" => (&["a:avLst"], &["prst"]),
        "a:avLst" | "a:noFill" | "a:round" | "a:bevel" => (&[], &[]),
        "a:solidFill" => (&["a:srgbClr", "a:schemeClr", "a:prstClr"], &[]),
        "a:srgbClr" | "a:schemeClr" | "a:prstClr" | "a:prstDash" => (&[], &["val"]),
        "a:ln" => (&["a:noFill", "a:solidFill", "a:prstDash", "a:round", "a:bevel", "a:miter", "a:headEnd", "a:tailEnd"], &["w", "cap", "cmpd", "algn"]),
        "a:miter" => (&[], &["lim"]),
        "a:headEnd" | "a:tailEnd" => (&[], &["type", "w", "len"]),
        _ => return None,
    })
}

fn picture_grammar_problem(drawing: &XmlElement, word: &str) -> bool {
    let ns = namespaces(word);
    let prefixes: [(&str, &str); 7] = [
        (ns.wp.as_str(), "wp"),
        (ns.a.as_str(), "a"),
        (ns.pic.as_str(), "pic"),
        (ns.r, "r"),
        ("http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing", "wp14"),
        ("http://schemas.microsoft.com/office/drawing/2010/main", "a14"),
        ("http://schemas.microsoft.com/office/drawing/2016/SVG/main", "asvg"),
    ];
    let key = |namespace: &str, local: &str| prefixes.iter().find(|(n, _)| *n == namespace).map(|(_, p)| format!("{p}:{local}"));
    let has_text = |n: &XmlElement| !ws_only(&n.text);
    if drawing.children.len() != 1 || has_text(drawing) || drawing.attributes.iter().any(|a| a.namespace != XMLNS_NAMESPACE) {
        return true;
    }
    for node in xml_descendants(&drawing.children[0]) {
        let name = key(&node.namespace, &node.local_name);
        let Some((children, attributes)) = name.as_deref().and_then(picture_rule) else { return true };
        if has_text(node) {
            return true;
        }
        if node.children.iter().any(|c| !children.contains(&key(&c.namespace, &c.local_name).unwrap_or_default().as_str())) {
            return true;
        }
        if node.attributes.iter().any(|a| {
            a.namespace != XMLNS_NAMESPACE && !attributes.contains(&if a.namespace.is_empty() { a.local_name.clone() } else { key(&a.namespace, &a.local_name).unwrap_or_default() }.as_str())
        }) {
            return true;
        }
    }
    false
}

#[derive(Clone, Debug)]
pub(crate) struct InternalImage {
    pub id: String,
    pub paragraph_id: String,
    pub width_points: f64,
    pub height_points: f64,
    pub alt_text: String,
    pub content_type: ImageType,
    pub drawing_start: usize,
    pub drawing_end: usize,
    pub part_name: String,
    pub relationship_id: String,
}

pub(crate) struct ImageInspection {
    pub images: Vec<InternalImage>,
    pub problem: Option<&'static str>,
}

pub(crate) fn inspect_docx_images(state: &State) -> Result<ImageInspection> {
    let fail = |p| Ok(ImageInspection { images: vec![], problem: Some(p) });
    let root = parse_xml(&state.source)?;
    let ns = namespaces(&root.namespace);
    let all = xml_descendants(&root);
    let drawings: Vec<&XmlElement> = all.iter().copied().filter(|n| is_word(n, "drawing")).collect();
    if drawings.is_empty() {
        return Ok(ImageInspection { images: vec![], problem: None });
    }
    if drawings.len() > 100 {
        return fail("Too many inline pictures.");
    }
    let rel_source = docx_part_source(state, &docx_relationships_part(&state.main_part))?;
    let rel_root = rel_source.map(|s| parse_xml(&s)).transpose()?;
    let rels: &[XmlElement] = rel_root.as_ref().map_or(&[], |r| &r.children);
    let manifest = parse_xml(&docx_part_source(state, "[Content_Types].xml")?.unwrap_or_default())?;
    let mut images = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    let mut total_pixels: u64 = 0;
    let image_relation = |rid: Option<&str>| -> Option<&XmlElement> {
        let rid = rid?;
        rels.iter().find(|n| n.plain("Id") == Some(rid) && n.plain("Type") == Some(&format!("{}/image", ns.r)) && n.plain("TargetMode").unwrap_or("Internal") == "Internal")
    };
    for drawing in drawings {
        let nodes = xml_descendants(drawing);
        let inline = drawing.children.first();
        let find = |ns: &str, name: &str| nodes.iter().copied().find(|n| n.namespace == ns && n.local_name == name);
        let doc_pr = find(&ns.wp, "docPr");
        let extent = find(&ns.wp, "extent");
        let blip = find(&ns.a, "blip");
        let id = doc_pr.and_then(|d| d.plain("id"));
        let relationship_id = blip.and_then(|b| xml_attribute(b, "embed", ns.r));
        let relation = image_relation(relationship_id);
        let target = relation.and_then(|r| r.plain("Target"));
        let part_name = target.map(|t| resolve_relative(&state.main_part, t));
        // Declared by a part override, or (as Word usually writes it) by extension.
        let declaration = part_name.as_deref().and_then(|p| {
            let ext = p.rsplit('.').next().unwrap_or("").to_lowercase();
            manifest
                .children
                .iter()
                .find(|n| n.local_name == "Override" && n.plain("PartName") == Some(&format!("/{p}")))
                .or_else(|| manifest.children.iter().find(|n| n.local_name == "Default" && n.plain("Extension").map(str::to_lowercase).as_deref() == Some(ext.as_str())))
        });
        let content_type = declaration.and_then(|d| d.plain("ContentType")).map(|t| t.split(';').next().unwrap_or("").trim().to_lowercase());
        // Any other picture reference (an SVG companion blip) must be an embedded package part too.
        let other_embeds: Vec<(&str, &str)> = nodes
            .iter()
            .flat_map(|n| n.attributes.iter().filter(|a| a.namespace == ns.r && (blip.is_none_or(|b| b.start != n.start) || a.local_name != "embed")).map(|a| (a.local_name.as_str(), a.value.as_str())))
            .collect();
        if other_embeds.iter().any(|(local, value)| {
            *local != "embed"
                || image_relation(Some(value)).and_then(|r| r.plain("Target")).is_none_or(|t| docx_part(state, &resolve_relative(&state.main_part, t)).is_none())
        }) {
            return fail("Picture references a linked or unresolved resource.");
        }
        let data = part_name.as_deref().and_then(|p| docx_part(state, p));
        let run = all.iter().find(|n| is_word(n, "r") && n.has_child(drawing.start));
        let paragraph = run.and_then(|r| all.iter().find(|n| is_word(n, "p") && n.has_child(r.start)));
        let (cx, cy) = (extent.and_then(|e| e.plain("cx")), extent.and_then(|e| e.plain("cy")));
        let emu = |v: Option<&str>| v.filter(|s| digits(s)).and_then(|s| s.parse::<u64>().ok()).filter(|v| (12700..=25_400_000).contains(v));
        let kind = content_type.as_deref().and_then(ImageType::from_mime);
        let valid = inline.is_some_and(|i| i.namespace == ns.wp && i.local_name == "inline")
            && drawing.children.len() == 1
            && id.is_some_and(|i| i == "0" || (digits(i) && !i.starts_with('0') && i.len() <= 9))
            && relationship_id.is_some()
            && relation.is_some()
            && part_name.is_some()
            && data.is_some()
            && kind.is_some()
            && run.is_some()
            && paragraph.is_some()
            && emu(cx).is_some()
            && emu(cy).is_some();
        if !valid {
            return fail("Unsupported or unresolved inline image.");
        }
        let graphic_data = find(&ns.a, "graphicData");
        let geometry = find(&ns.a, "prstGeom");
        if picture_grammar_problem(drawing, &root.namespace)
            || geometry.is_some_and(|g| g.plain("prst") != Some("rect"))
            || graphic_data.is_none_or(|g| g.plain("uri") != Some(ns.pic.as_str()))
            || nodes.iter().filter(|n| n.namespace == ns.a && n.local_name == "blip").count() != 1
        {
            return fail("Picture contains unsupported DrawingML effects, shapes or links.");
        }
        match inspect_docx_bitmap(data.unwrap(), kind.unwrap()) {
            Ok(bitmap) => {
                total_pixels += bitmap.width as u64 * bitmap.height as u64;
                if total_pixels > 64_000_000 {
                    return fail("Document exceeds the aggregate image pixel budget.");
                }
            }
            Err(_) => return fail("Embedded bitmap failed structural validation."),
        }
        // Generators sometimes repeat a drawing id; repeats get an occurrence suffix.
        let id = id.unwrap();
        let mut identity = id.to_string();
        let mut n = 2;
        while ids.contains(&identity) {
            identity = format!("{id}~{n}");
            n += 1;
        }
        ids.push(identity.clone());
        images.push(InternalImage {
            id: identity,
            paragraph_id: state.identities.get(&paragraph.unwrap().start).cloned().unwrap_or_default(),
            width_points: emu(cx).unwrap() as f64 / 12700.0,
            height_points: emu(cy).unwrap() as f64 / 12700.0,
            alt_text: doc_pr.and_then(|d| d.plain("descr")).unwrap_or("").to_string(),
            content_type: kind.unwrap(),
            drawing_start: drawing.start,
            drawing_end: drawing.end,
            part_name: part_name.unwrap(),
            relationship_id: relationship_id.unwrap().to_string(),
        });
    }
    Ok(ImageInspection { images, problem: None })
}

pub(crate) fn insert_docx_image(state: &State, input: &ImageInput) -> Result<State> {
    inspect_docx_bitmap(&input.bytes, input.content_type)?;
    let alt = input.alt_text.clone().unwrap_or_default();
    if ![input.width_points, input.height_points].iter().all(|v| v.is_finite() && (1.0..=2000.0).contains(v)) || alt.chars().map(char::len_utf16).sum::<usize>() > 2000 {
        return Err(bad("Invalid image display size or alternative text."));
    }
    let root = parse_xml(&state.source)?;
    let body = word_child(Some(&root), "body").expect("body");
    let current = inspect_docx_images(state)?;
    if let Some(p) = current.problem {
        return Err(bad(p));
    }
    if current.images.len() >= 100 {
        return Err(bad("A document may contain at most 100 supported pictures."));
    }
    let directory = &state.main_part[..state.main_part.rfind('/').map_or(0, |s| s + 1)];
    let ext = if input.content_type == ImageType::Png { "png" } else { "jpg" };
    let mut name = format!("{directory}media/markie-image1.{ext}");
    let mut n = 2;
    while docx_part(state, &name).is_some() || state.deleted_parts.contains(&name) {
        name = format!("{directory}media/markie-image{n}.{ext}");
        n += 1;
    }
    let rel_name = docx_relationships_part(&state.main_part);
    let rel_source = docx_part_source(state, &rel_name)?.unwrap_or_else(|| format!("<Relationships xmlns=\"{DOCX_REL}\"/>"));
    let ids: Vec<String> = parse_xml(&rel_source)?.children.iter().filter_map(|n| n.plain("Id").map(str::to_string)).collect();
    let mut id = "rIdImage1".to_string();
    let mut k = 2;
    while ids.contains(&id) {
        id = format!("rIdImage{k}");
        k += 1;
    }
    let ns = namespaces(&root.namespace);
    let mut overrides = state.part_overrides.clone();
    overrides.set(&name, input.bytes.clone());
    overrides.set(&rel_name, append_docx_xml(&rel_source, &format!("<Relationship xmlns=\"{DOCX_REL}\" Id=\"{id}\" Type=\"{}/image\" Target=\"{}\"/>", ns.r, &name[directory.len()..]))?.into_bytes());
    let manifest = docx_part_source(state, "[Content_Types].xml")?.unwrap_or_default();
    let with_override = append_docx_xml(
        &manifest,
        &format!("<Override xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\" PartName=\"/{name}\" ContentType=\"{}\"/>", input.content_type.mime()),
    )?;
    overrides.set("[Content_Types].xml", declare_docx_relationship_part(&with_override, &rel_name)?.into_bytes());
    let offset = match &input.after_paragraph_id {
        InsertAt::Start => body.start_tag_end,
        InsertAt::End => word_child(Some(body), "sectPr").map_or(body.end_tag_start, |s| s.start),
        InsertAt::After(pid) => {
            body.children
                .iter()
                .find(|n| is_word(n, "p") && state.identities.get(&n.start) == Some(pid))
                .ok_or_else(|| invalid("invalid-edit", "Image insertion requires a top-level paragraph."))?
                .end
        }
    };
    let next_image_id =
        state.next_image_id.unwrap_or_else(|| current.images.iter().map(|i| i.id.split('~').next().unwrap_or("0").parse::<u64>().unwrap_or(0)).max().unwrap_or(0) + 1);
    let xml = format!(
        "<w:p xmlns:w=\"{}\">{}</w:p>",
        root.namespace,
        make_inline(&root.namespace, &id, &next_image_id.to_string(), input.width_points, input.height_points, &alt)?
    );
    let mut next = patch_docx_source(state, vec![Patch::new(offset, offset, xml)])?;
    next.part_overrides = overrides;
    next.next_image_id = Some(next_image_id + 1);
    Ok(next)
}

pub(crate) fn delete_docx_image(state: &State, id: &str) -> Result<State> {
    let inspected = inspect_docx_images(state)?;
    if let Some(p) = inspected.problem {
        return Err(bad(p));
    }
    let image = inspected.images.iter().find(|i| i.id == id).ok_or_else(|| invalid("invalid-image", "Unknown image identity."))?;
    let mut overrides = state.part_overrides.clone();
    let mut deleted = state.deleted_parts.clone();
    // A run can hold text or another picture alongside this drawing; remove only the drawing.
    let mut next = patch_docx_source(state, vec![Patch::new(image.drawing_start, image.drawing_end, "")])?;
    if !inspected.images.iter().any(|o| o.id != id && o.relationship_id == image.relationship_id) {
        let rel_name = docx_relationships_part(&state.main_part);
        let source = docx_part_source(state, &rel_name)?.unwrap_or_default();
        let rels = parse_xml(&source)?;
        if let Some(relation) = rels.children.iter().find(|n| n.plain("Id") == Some(image.relationship_id.as_str())) {
            overrides.set(&rel_name, format!("{}{}", &source[..relation.start], &source[relation.end..]).into_bytes());
        }
    }
    if !inspected.images.iter().any(|o| o.id != id && o.part_name == image.part_name) {
        // Refuse to erase data referenced anywhere else in the package graph.
        let main_rels = docx_relationships_part(&state.main_part);
        for name in state.all_part_names().into_iter().filter(|n| n.ends_with(".rels")) {
            let source_part = super::relationship_source(&name).unwrap_or_default();
            let Some(source) = docx_part_source(state, &name)? else { continue };
            let root = parse_xml(&source)?;
            let other = root.children.iter().any(|relation| {
                if name == main_rels && relation.plain("Id") == Some(image.relationship_id.as_str()) {
                    return false;
                }
                if relation.plain("TargetMode") == Some("External") {
                    return false;
                }
                let target = relation.plain("Target").unwrap_or("");
                resolve_relative(&source_part, target) == image.part_name
            });
            if other {
                return Err(invalid("unsupported-image", "Image has another package owner and cannot be erased safely."));
            }
        }
        deleted.insert(image.part_name.clone());
        overrides.remove(&image.part_name);
        let manifest = docx_part_source(state, "[Content_Types].xml")?.unwrap_or_default();
        let m = parse_xml(&manifest)?;
        if let Some(o) = m.children.iter().find(|n| n.plain("PartName") == Some(&format!("/{}", image.part_name))) {
            overrides.set("[Content_Types].xml", format!("{}{}", &manifest[..o.start], &manifest[o.end..]).into_bytes());
        }
    }
    next.part_overrides = overrides;
    next.deleted_parts = deleted;
    Ok(next)
}
