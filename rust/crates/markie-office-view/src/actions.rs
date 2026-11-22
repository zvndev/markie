//! GPUI actions for the Word view: one per menu command id, plus the editing
//! actions (clipboard, undo, select all). Menus and key bindings for the app.

use gpui_kit::*;

/// Declares one action per command id, the id lookup, and the conditional
/// registration that only offers commands the selection allows. A command
/// that is not registered shows disabled in the native menu.
macro_rules! word_commands {
    ($($action:ident => $id:literal),* $(,)?) => {
        gpui_kit::actions!(markie_word, [$($action),*]);

        /// The action for a command id.
        pub fn command_action(id: &str) -> Option<Box<dyn Action>> {
            match id {
                $($id => Some(Box::new($action)),)*
                _ => None,
            }
        }

        pub(crate) fn register_commands<E: InteractiveElement>(
            mut element: E,
            available: &[&'static str],
            cx: &mut Context<crate::view::WordView>,
        ) -> E {
            $(
                if available.contains(&$id) {
                    element = element.on_action(cx.listener(|this, _: &$action, window, cx| this.command($id, window, cx)));
                }
            )*
            element
        }
    };
}

word_commands! {
    FormatBold => "format-bold",
    FormatItalic => "format-italic",
    FormatUnderline => "format-underline",
    FormatStrike => "format-strike",
    FormatClear => "format-clear",
    FormatFont => "format-font",
    FormatNormal => "format-normal",
    FormatHeading1 => "format-heading-1",
    FormatHeading2 => "format-heading-2",
    FormatHeading3 => "format-heading-3",
    FormatBullets => "format-bullets",
    FormatNumbering => "format-numbering",
    FormatAlignLeft => "format-align-left",
    FormatAlignCenter => "format-align-center",
    FormatAlignRight => "format-align-right",
    FormatAlignJustify => "format-align-justify",
    InsertParagraph => "insert-paragraph",
    InsertPicture => "insert-picture",
    InsertTable => "insert-table",
    InsertLink => "insert-link",
    InsertPageBreak => "insert-page-break",
    LayoutPageSetup => "layout-page-setup",
    LayoutLetter => "layout-letter",
    LayoutA4 => "layout-a4",
    LayoutLegal => "layout-legal",
    LayoutPortrait => "layout-portrait",
    LayoutLandscape => "layout-landscape",
    LayoutParagraphSpacing => "layout-paragraph-spacing",
    ReviewComments => "review-comments",
    ReviewTracking => "review-tracking",
    ReviewChanges => "review-changes",
    ReviewOriginal => "review-original",
    ReviewFinal => "review-final",
    ViewPage => "view-page",
    ViewContinuous => "view-continuous",
    ViewOutline => "view-outline",
    ViewZoomReset => "view-zoom-reset",
    ViewLightPaper => "view-light-paper",
}

gpui_kit::actions!(markie_word, [WordCopy, WordCut, WordPaste, WordSelectAll, WordUndo, WordRedo, WordFind]);

/// The key context of the editing surface.
pub const CONTEXT: &str = "WordView";

pub fn bind_keys(cx: &mut App) {
    let context = Some(CONTEXT);
    cx.bind_keys([
        KeyBinding::new("cmd-b", FormatBold, context),
        KeyBinding::new("cmd-i", FormatItalic, context),
        KeyBinding::new("cmd-u", FormatUnderline, context),
        KeyBinding::new("cmd-c", WordCopy, context),
        KeyBinding::new("cmd-x", WordCut, context),
        KeyBinding::new("cmd-v", WordPaste, context),
        KeyBinding::new("cmd-a", WordSelectAll, context),
        KeyBinding::new("cmd-z", WordUndo, context),
        KeyBinding::new("cmd-shift-z", WordRedo, context),
        KeyBinding::new("cmd-f", WordFind, context),
    ]);
}

/// Menu separators go before these ids, grouping commands as Electron does.
const SEPARATE_BEFORE: &[&str] = &[
    "format-font",
    "format-normal",
    "format-bullets",
    "format-align-left",
    "insert-picture",
    "layout-letter",
    "layout-portrait",
    "layout-paragraph-spacing",
    "review-original",
    "view-zoom-reset",
];

fn group(name: &str) -> Vec<MenuItem> {
    let mut items = Vec::new();
    for (_, id, label) in crate::commands::COMMANDS.iter().filter(|(g, _, _)| *g == name) {
        if !items.is_empty() && SEPARATE_BEFORE.contains(id) {
            items.push(MenuItem::separator());
        }
        if let Some(action) = command_action(id) {
            items.push(MenuItem::Action { name: (*label).into(), action, os_action: None, checked: false, disabled: false });
        }
    }
    items
}

/// Format, Insert, Layout and Review menus for the app's menu bar.
pub fn menus() -> Vec<Menu> {
    ["Format", "Insert", "Layout", "Review"]
        .into_iter()
        .map(|name| Menu { name: name.into(), items: group(name), disabled: false })
        .collect()
}

/// The Word layout items for the app's View menu.
pub fn view_menu_items() -> Vec<MenuItem> {
    group("View").into_iter().filter(|item| {
        !matches!(item, MenuItem::Action { name, .. } if name.as_ref() == "Actual Size")
    }).collect()
}
