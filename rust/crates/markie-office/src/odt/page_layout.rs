//! Original single-master geometry subset of OASIS ODF 1.3 Part 3, sections
//! 16.5 and 17.2. Ported from `odt-page-layout.ts`.

use super::{FO, OFFICE, STYLE, attrs, is};
use crate::error::{OfficeError, Result};
use crate::model::{Orientation, PageLayout, js_number};
use crate::xml::{XmlElement, xml_attribute};

fn fail() -> OfficeError {
    OfficeError::docx("unsupported-odt", "Unsupported or ambiguous ODT page layout; the original file was not converted.")
}

pub(crate) fn unit_factor(unit: &str) -> Option<f64> {
    Some(match unit {
        "pt" => 1.0,
        "in" => 72.0,
        "cm" => 72.0 / 2.54,
        "mm" => 72.0 / 25.4,
        "pc" => 12.0,
        _ => return None,
    })
}

/// Splits `^(\d+(?:\.\d+)?)(unit)$` into number and unit.
pub(crate) fn split_length(value: &str) -> Option<(f64, &str)> {
    let digits = value.bytes().take_while(|b| b.is_ascii_digit() || *b == b'.').count();
    let (number, unit) = value.split_at(digits);
    let mut parts = number.split('.');
    let whole = parts.next()?;
    let fraction = parts.next();
    if whole.is_empty() || parts.next().is_some() || fraction.is_some_and(|f| f.is_empty()) {
        return None;
    }
    Some((number.parse().ok()?, unit))
}

fn points(value: Option<&str>) -> Result<f64> {
    let (number, unit) = split_length(value.unwrap_or("")).ok_or_else(fail)?;
    let result = number * unit_factor(unit).ok_or_else(fail)?;
    if !result.is_finite() || result > 2000.0 {
        return Err(fail());
    }
    Ok(result)
}

#[derive(Clone, Debug)]
pub(crate) struct OdtPageGeometry {
    pub layout: PageLayout,
    /// Offsets of the page-layout-properties element in styles.xml.
    pub properties_start: usize,
    pub properties_end: usize,
}

/// Layout styles live in styles.xml automatic-styles. A sole static master is
/// the document default. Paragraph master references stay unsupported.
pub(crate) fn read_odt_page_geometry(roots: &[&XmlElement]) -> Result<Option<OdtPageGeometry>> {
    let mut layouts: Vec<&XmlElement> = Vec::new();
    let mut masters: Vec<&XmlElement> = Vec::new();
    for root in roots {
        for container in &root.children {
            if is(container, OFFICE, "automatic-styles") {
                for node in &container.children {
                    if is(node, STYLE, "page-layout") {
                        if !is(root, OFFICE, "document-styles") {
                            return Err(fail());
                        }
                        layouts.push(node);
                    }
                }
            }
            if is(container, OFFICE, "master-styles") {
                attrs(container, &[]).map_err(|_| fail())?;
                if !is(root, OFFICE, "document-styles") || !container.text.trim().is_empty() {
                    return Err(fail());
                }
                for node in &container.children {
                    if !is(node, STYLE, "master-page") {
                        return Err(fail());
                    }
                    masters.push(node);
                }
            }
        }
    }
    if layouts.is_empty() && masters.is_empty() {
        return Ok(None);
    }
    if layouts.len() != 1 || masters.len() != 1 {
        return Err(fail());
    }
    let (layout, master) = (layouts[0], masters[0]);
    attrs(layout, &[(STYLE, "name"), (STYLE, "page-usage")]).map_err(|_| fail())?;
    let usage = xml_attribute(layout, "page-usage", STYLE);
    if usage.is_some_and(|u| u != "all") || !layout.text.trim().is_empty() || layout.children.len() != 1 {
        return Err(fail());
    }
    attrs(master, &[(STYLE, "name"), (STYLE, "display-name"), (STYLE, "page-layout-name"), (STYLE, "next-style-name")]).map_err(|_| fail())?;
    let name = xml_attribute(master, "name", STYLE);
    let layout_name = xml_attribute(layout, "name", STYLE);
    let next = xml_attribute(master, "next-style-name", STYLE);
    let (Some(name), Some(layout_name)) = (name, layout_name) else { return Err(fail()) };
    if utf16(name) > 200
        || utf16(layout_name) > 200
        || next.is_some_and(|n| n != name)
        || xml_attribute(master, "page-layout-name", STYLE) != Some(layout_name)
        || !master.children.is_empty()
        || !master.text.trim().is_empty()
    {
        return Err(fail());
    }
    let properties = &layout.children[0];
    if !is(properties, STYLE, "page-layout-properties") || !properties.children.is_empty() || !properties.text.trim().is_empty() {
        return Err(fail());
    }
    attrs(
        properties,
        &[
            (FO, "page-width"),
            (FO, "page-height"),
            (FO, "margin"),
            (FO, "margin-top"),
            (FO, "margin-right"),
            (FO, "margin-bottom"),
            (FO, "margin-left"),
            (STYLE, "print-orientation"),
        ],
    )
    .map_err(|_| fail())?;
    let width = points(xml_attribute(properties, "page-width", FO))?;
    let height = points(xml_attribute(properties, "page-height", FO))?;
    let orientation = xml_attribute(properties, "print-orientation", STYLE).unwrap_or("portrait");
    if !(orientation == "portrait" || orientation == "landscape")
        || width.min(height) < 72.0
        || (if orientation == "portrait" { width > height } else { height > width })
    {
        return Err(fail());
    }
    let margin = xml_attribute(properties, "margin", FO);
    let side = |n: &str| points(xml_attribute(properties, n, FO).or(margin));
    let (top, right, bottom, left) = (side("margin-top")?, side("margin-right")?, side("margin-bottom")?, side("margin-left")?);
    if top.max(right).max(bottom).max(left) > 1440.0 || top + bottom >= height || left + right >= width {
        return Err(fail());
    }
    Ok(Some(OdtPageGeometry {
        layout: PageLayout {
            width_points: width,
            height_points: height,
            orientation: if orientation == "landscape" { Orientation::Landscape } else { Orientation::Portrait },
            margin_top_points: top,
            margin_right_points: right,
            margin_bottom_points: bottom,
            margin_left_points: left,
        },
        properties_start: properties.start,
        properties_end: properties.end,
    }))
}

fn utf16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

pub(crate) fn odt_page_properties(layout: &PageLayout) -> String {
    let o = if layout.orientation == Orientation::Landscape { "landscape" } else { "portrait" };
    format!(
        "<style:page-layout-properties xmlns:style=\"{STYLE}\" xmlns:fo=\"{FO}\" fo:page-width=\"{}pt\" fo:page-height=\"{}pt\" style:print-orientation=\"{o}\" fo:margin-top=\"{}pt\" fo:margin-right=\"{}pt\" fo:margin-bottom=\"{}pt\" fo:margin-left=\"{}pt\"/>",
        js_number(layout.width_points),
        js_number(layout.height_points),
        js_number(layout.margin_top_points),
        js_number(layout.margin_right_points),
        js_number(layout.margin_bottom_points),
        js_number(layout.margin_left_points)
    )
}

pub(crate) fn odt_page_styles(layout: &PageLayout, name: &str) -> (String, String) {
    (
        format!("<style:page-layout xmlns:style=\"{STYLE}\" style:name=\"{name}\">{}</style:page-layout>", odt_page_properties(layout)),
        format!(
            "<office:master-styles xmlns:office=\"{OFFICE}\" xmlns:style=\"{STYLE}\"><style:master-page xmlns:style=\"{STYLE}\" style:name=\"{name}\" style:page-layout-name=\"{name}\"/></office:master-styles>"
        ),
    )
}

pub(crate) fn append_odt_xml(source: &str, node: &XmlElement, markup: &str) -> String {
    if !node.self_closing() {
        return format!("{}{markup}{}", &source[..node.end_tag_start], &source[node.end_tag_start..]);
    }
    let opening = &source[node.start..node.start_tag_end];
    let opening = opening.strip_suffix("/>").map_or(opening.to_string(), |o| format!("{o}>"));
    format!("{}{opening}{markup}</{}>{}", &source[..node.start], node.name, &source[node.end..])
}
