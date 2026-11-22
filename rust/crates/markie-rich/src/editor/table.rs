//! The table bar's commands (`TableBar` in format-rail.tsx, which runs
//! prosemirror-tables through TipTap's TableKit): rows and columns before
//! and after the caret's cell, deleting a row, a column or the table.
//!
//! Markdown holds a table with exactly one header row, its first. So where
//! TipTap would make a second header row (a row added above the header) the
//! new row takes the header and the old one becomes a body row, and the
//! header row cannot be switched off. Electron writes such tables as HTML.

use super::tree::{self, Frame};
use super::{EditKind, Editor};
use crate::model::*;

/// Where the caret's cell is: its table, row and column.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CellAt {
    pub block: usize,
    /// Container path and index of the table node.
    pub table: (Vec<usize>, usize),
    pub row: usize,
    pub col: usize,
    pub rows: usize,
    pub cols: usize,
}

fn empty_cell(header: bool, align: Option<Align>) -> Cell {
    Cell { header, align, content: vec![Node::para(vec![])] }
}

impl Editor {
    /// The caret's table cell, if it is in one.
    pub fn cell_at_caret(&self) -> Option<CellAt> {
        let p = self.head;
        let leaf = self.leaf(p)?;
        let pos = leaf.frames.iter().rposition(|f| matches!(f, Frame::Cell { .. }))?;
        let Frame::Cell { row, col } = leaf.frames[pos] else { return None };
        let nodes = self.doc.blocks.get(p.block)?.nodes().to_vec();
        let (tc, ti) = tree::ancestors(&nodes, &leaf.path).get(pos).cloned()?;
        let Some(Node::Table { rows }) = tree::container_of(&nodes, &tc).and_then(|c| c.get(ti)) else { return None };
        let cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        Some(CellAt { block: p.block, table: (tc, ti), row, col, rows: rows.len(), cols })
    }

    pub fn in_table(&self) -> bool {
        self.cell_at_caret().is_some()
    }

    /// Change the caret's table; `f` gets the rows and returns the
    /// (row, col) the caret goes to.
    fn edit_table(&mut self, f: impl FnOnce(&mut Vec<Vec<Cell>>, &CellAt) -> Option<(usize, usize)>) {
        let Some(at) = self.cell_at_caret() else { return };
        self.break_undo();
        self.transact(at.block..at.block + 1, EditKind::Other, |ed| {
            let Some(nodes) = ed.nodes_mut(at.block) else { return };
            let Some(Node::Table { rows }) = tree::container_mut(nodes, &at.table.0).and_then(|c| c.get_mut(at.table.1)) else { return };
            let Some((r, c)) = f(rows, &at) else { return };
            let r = r.min(rows.len().saturating_sub(1));
            let c = c.min(rows.get(r).map(|x| x.len()).unwrap_or(1).saturating_sub(1));
            let mut path = at.table.0.clone();
            path.extend([at.table.1, r, c, 0]);
            ed.put_caret(at.block, path, 0);
        });
    }

    /// `addRowBefore` / `addRowAfter`.
    pub fn add_row(&mut self, after: bool) {
        self.edit_table(|rows, at| {
            let cols = at.cols;
            let aligns: Vec<Option<Align>> = (0..cols).map(|c| rows[0].get(c).and_then(|x| x.align)).collect();
            if !after && at.row == 0 {
                // The new top row takes the header.
                for cell in rows[0].iter_mut() {
                    cell.header = false;
                }
                rows.insert(0, (0..cols).map(|c| empty_cell(true, aligns[c])).collect());
                return Some((0, at.col));
            }
            let at_row = if after { at.row + 1 } else { at.row };
            rows.insert(at_row, (0..cols).map(|c| empty_cell(false, aligns[c])).collect());
            Some((at_row, at.col))
        });
    }

    /// `addColumnBefore` / `addColumnAfter`.
    pub fn add_column(&mut self, after: bool) {
        self.edit_table(|rows, at| {
            let col = if after { at.col + 1 } else { at.col };
            for (r, row) in rows.iter_mut().enumerate() {
                let i = col.min(row.len());
                row.insert(i, empty_cell(r == 0, None));
            }
            Some((at.row, col))
        });
    }

    /// `deleteRow`: never the last row (prosemirror-tables refuses).
    pub fn delete_row(&mut self) {
        self.edit_table(|rows, at| {
            if rows.len() <= 1 {
                return None;
            }
            rows.remove(at.row);
            if at.row == 0 {
                // The row that is now first is the header.
                for cell in rows[0].iter_mut() {
                    cell.header = true;
                }
            }
            Some((at.row.min(rows.len() - 1), at.col))
        });
    }

    /// `deleteColumn`: never the last column.
    pub fn delete_column(&mut self) {
        self.edit_table(|rows, at| {
            if at.cols <= 1 {
                return None;
            }
            for row in rows.iter_mut() {
                if at.col < row.len() {
                    row.remove(at.col);
                }
            }
            Some((at.row, at.col.min(at.cols - 2)))
        });
    }

    /// `deleteTable`: the caret goes to what follows it.
    pub fn delete_table(&mut self) {
        let Some(at) = self.cell_at_caret() else { return };
        self.break_undo();
        self.transact(at.block..at.block + 1, EditKind::Other, |ed| {
            let Some(nodes) = ed.nodes_mut(at.block) else { return };
            let Some(cont) = tree::container_mut(nodes, &at.table.0) else { return };
            // A container never ends up empty: a paragraph takes its place.
            if cont.len() == 1 {
                cont[0] = Node::para(vec![]);
            } else {
                cont.remove(at.table.1);
            }
            let mut path = at.table.0.clone();
            let len = cont.len();
            path.push(at.table.1.min(len - 1));
            ed.put_caret(at.block, path, 0);
        });
    }
}
