//! Work-session clustering: files edited close together in time form one
//! block. A port of `src/lib/projects/cluster.ts`; read the comments there
//! before changing a rule here. Ids are deterministic (same project and same
//! founding file give the same id everywhere), so names and merges keyed to
//! them stay attached across machines and reruns.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;

use super::assign::EngineFile;
use super::rules::ClusteringTunables;
use super::{iso_from_ms, max_of, min_of};

#[derive(Clone, Debug, PartialEq)]
pub struct PriorAssignment {
    pub path: String,
    pub block_id: Option<String>,
    pub mtime_ms: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BlockRecord {
    pub block_id: String,
    pub project: String,
    pub auto_name: String,
    pub custom_name: Option<String>,
    pub merged_into: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub struct DerivedBlocks {
    pub by_path: HashMap<String, String>,
    pub blocks: Vec<BlockRecord>,
}

/// djb2-xor over UTF-16 units, base 36, padded to seven.
pub fn hash8(s: &str) -> String {
    let mut h: u32 = 5381;
    for unit in s.encode_utf16() {
        h = h.wrapping_mul(33) ^ unit as u32;
    }
    let mut digits = Vec::new();
    let mut n = h;
    loop {
        digits.push(std::char::from_digit(n % 36, 36).unwrap());
        n /= 36;
        if n == 0 {
            break;
        }
    }
    let s: String = digits.into_iter().rev().collect();
    format!("{s:0>7}")
}

/// JavaScript `Math.round`: halves go up.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn js_number(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 1e21 { format!("{}", x as i64) } else { format!("{x}") }
}

fn mint_id(project: &str, founder: &EngineFile) -> String {
    format!("b_{}", hash8(&format!("{project}:{}:{}", founder.path, js_number(js_round(founder.mtime_ms)))))
}

fn resolve_merge(id: &str, by_id: &HashMap<&str, &BlockRecord>) -> String {
    let mut cur = id.to_string();
    for _ in 0..20 {
        match by_id.get(cur.as_str()).and_then(|r| r.merged_into.clone()) {
            Some(next) => cur = next,
            None => return cur,
        }
    }
    cur
}

fn stem(name: &str) -> &str {
    match name.rfind('.') {
        Some(i) if i + 1 < name.len() => &name[..i],
        _ => name,
    }
}

static DATE_HEAD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:\d{4}[-_.]\d{2}[-_.]\d{2}|\d{8}|\d{4}[-_.]\d{2})(?:[-_.]|$)").unwrap());
static DATE_TAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[-_.](?:\d{4}[-_.]\d{2}[-_.]\d{2}|\d{8}|\d{4}[-_.]\d{2})$").unwrap());

/// A date stamp says when, never what: strip it from both ends unless that
/// would leave nothing.
pub fn strip_date_stamp(name: &str) -> String {
    let mut out = name.to_string();
    let head = DATE_HEAD.replace(&out, "").into_owned();
    if !head.trim().is_empty() {
        out = head;
    }
    let tail = DATE_TAIL.replace(&out, "").into_owned();
    if !tail.trim().is_empty() {
        out = tail;
    }
    out
}

/// A slug made readable: only an all-lowercase leading word is capitalized.
pub fn humanize_stem(name: &str) -> String {
    let stripped = strip_date_stamp(name);
    let words: Vec<&str> = stripped.split(|c: char| c == '-' || c == '_' || c.is_whitespace()).filter(|w| !w.is_empty()).collect();
    let Some((first, rest)) = words.split_first() else { return name.to_string() };
    let head = if first.chars().any(|c| c.is_ascii_uppercase()) {
        first.to_string()
    } else {
        let mut cs = first.chars();
        let c = cs.next().unwrap();
        c.to_uppercase().chain(cs).collect()
    };
    std::iter::once(head.as_str()).chain(rest.iter().copied()).collect::<Vec<_>>().join(" ")
}

fn segments(dir: &str) -> Vec<&str> {
    dir.split(['/', '\\']).filter(|s| !s.is_empty()).collect()
}

/// Depth of the deepest folder every file shares.
pub fn common_root_depth(files: &[&EngineFile]) -> usize {
    let Some(first) = files.first() else { return 0 };
    let mut root = segments(&first.dir);
    for f in files {
        let segs = segments(&f.dir);
        let i = root.iter().zip(&segs).take_while(|(a, b)| a == b).count();
        root.truncate(i);
    }
    root.len()
}

fn dominant_branch(files: &[&EngineFile], root_depth: usize) -> Option<String> {
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for f in files {
        let segs = segments(&f.dir);
        let Some(b) = segs.get(root_depth).copied() else { continue };
        match counts.iter_mut().find(|(k, _)| *k == b) {
            Some(e) => e.1 += 1,
            None => counts.push((b, 1)),
        }
    }
    let mut best: Option<&str> = None;
    let mut best_n = 0;
    for (folder, n) in counts {
        if n > best_n {
            best = Some(folder);
            best_n = n;
        }
    }
    best.filter(|_| best_n * 2 >= files.len()).map(str::to_string)
}

pub fn block_name_candidates(members: &[&EngineFile], root_depth: usize, now: f64) -> Vec<String> {
    let mut out = Vec::new();
    let shared = common_root_depth(members);
    if shared > root_depth
        && let Some(own) = segments(&members[0].dir).get(shared - 1)
    {
        out.push(strip_date_stamp(own));
    }
    if let Some(dom) = dominant_branch(members, root_depth) {
        out.push(strip_date_stamp(&dom));
    }
    let mut newest: Option<&EngineFile> = None;
    for f in members {
        if newest.is_none_or(|n| f.mtime_ms > n.mtime_ms) {
            newest = Some(f);
        }
    }
    if let Some(n) = newest {
        out.push(humanize_stem(stem(&n.name)));
    }
    let when = newest.map_or(now, |n| n.mtime_ms);
    out.push(format!("Work session {}", &iso_from_ms(when)[..10]));
    out.retain(|s| !s.is_empty());
    out
}

pub fn pick_block_name(candidates: &[String], taken: &HashSet<String>) -> String {
    if let Some(c) = candidates.iter().find(|c| !taken.contains(*c)) {
        return c.clone();
    }
    let base = candidates.first().cloned().unwrap_or_else(|| "Work session".into());
    let mut name = base.clone();
    let mut n = 2;
    while taken.contains(&name) {
        name = format!("{base} ({n})");
        n += 1;
    }
    name
}

type Cluster<'a> = Vec<&'a EngineFile>;

fn by_mtime_desc(a: &&EngineFile, b: &&EngineFile) -> std::cmp::Ordering {
    b.mtime_ms.partial_cmp(&a.mtime_ms).unwrap_or(std::cmp::Ordering::Equal)
}

fn cluster_by_gap<'a>(files: &[&'a EngineFile], gap: f64) -> Vec<Cluster<'a>> {
    let mut sorted = files.to_vec();
    sorted.sort_by(by_mtime_desc);
    let mut clusters = Vec::new();
    let mut current: Cluster = Vec::new();
    let mut last: Option<f64> = None;
    for f in sorted {
        if let Some(l) = last
            && l - f.mtime_ms > gap
        {
            clusters.push(std::mem::take(&mut current));
        }
        current.push(f);
        last = Some(f.mtime_ms);
    }
    if !current.is_empty() {
        clusters.push(current);
    }
    clusters
}

fn absorb_small_clusters<'a>(clusters: Vec<Cluster<'a>>, min_files: f64) -> Vec<Cluster<'a>> {
    if min_files <= 1.0 || clusters.len() < 2 {
        return clusters;
    }
    let mut out = clusters;
    let mut alive = vec![true; out.len()];
    for i in 0..out.len() {
        if !alive[i] || out[i].len() as f64 >= min_files {
            continue;
        }
        let mut prev = i as isize - 1;
        while prev >= 0 && !alive[prev as usize] {
            prev -= 1;
        }
        let mut next = i + 1;
        while next < out.len() && !alive[next] {
            next += 1;
        }
        let mine = max_of(out[i].iter().map(|f| f.mtime_ms));
        let prev_dist =
            if prev >= 0 { (min_of(out[prev as usize].iter().map(|f| f.mtime_ms)) - mine).abs() } else { f64::INFINITY };
        let next_dist =
            if next < out.len() { (mine - max_of(out[next].iter().map(|f| f.mtime_ms))).abs() } else { f64::INFINITY };
        if prev_dist.is_infinite() && next_dist.is_infinite() {
            continue;
        }
        let target = if prev_dist <= next_dist { prev as usize } else { next };
        let moved = std::mem::take(&mut out[i]);
        out[target].extend(moved);
        alive[i] = false;
    }
    out.into_iter().zip(alive).filter(|(_, a)| *a).map(|(c, _)| c).collect()
}

fn is_bulk_cluster(cluster: &[&EngineFile], t: &ClusteringTunables) -> bool {
    if (cluster.len() as f64) < t.bulk_min_files {
        return false;
    }
    let times = || cluster.iter().map(|f| f.mtime_ms);
    max_of(times()) - min_of(times()) <= t.bulk_window_minutes * 60_000.0
}

pub fn split_oversized_by_path<'a>(cluster: Cluster<'a>, depth: usize, limit: f64) -> Vec<Cluster<'a>> {
    if cluster.len() as f64 <= limit {
        return vec![cluster];
    }
    // Insertion-ordered groups, like a JavaScript Map.
    let mut keys: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Cluster<'a>> = HashMap::new();
    for f in cluster.iter().copied() {
        let key = segments(&f.dir).get(depth).map_or(".".to_string(), |s| s.to_string());
        if !groups.contains_key(&key) {
            keys.push(key.clone());
        }
        groups.entry(key).or_default().push(f);
    }
    if groups.len() <= 1 {
        if groups.contains_key(".") {
            return vec![cluster];
        }
        return split_oversized_by_path(cluster, depth + 1, limit);
    }
    let mut out = Vec::new();
    for k in keys {
        let g = groups.remove(&k).unwrap();
        out.extend(split_oversized_by_path(g, depth + 1, limit));
    }
    out
}

const CONCENTRATION_MIN_PROJECT: usize = 10;

pub fn concentration_limit(project_size: usize, t: &ClusteringTunables) -> f64 {
    if project_size < CONCENTRATION_MIN_PROJECT {
        return f64::INFINITY;
    }
    1f64.max(t.max_block_files.min((project_size as f64 * t.max_block_share).floor()))
}

pub fn split_by_largest_gaps<'a>(cluster: Cluster<'a>, limit: f64) -> Vec<Cluster<'a>> {
    if cluster.len() as f64 <= limit {
        return vec![cluster];
    }
    let n = cluster.len();
    let mut sorted = cluster;
    sorted.sort_by(by_mtime_desc);
    let mut pieces = vec![sorted];
    for _ in 0..n {
        let mut worst: Option<usize> = None;
        let mut worst_size = limit;
        for (i, p) in pieces.iter().enumerate() {
            if p.len() as f64 > worst_size {
                worst_size = p.len() as f64;
                worst = Some(i);
            }
        }
        let Some(wi) = worst else { break };
        let piece = &pieces[wi];
        let middle = piece.len() as f64 / 2.0;
        let (mut cut, mut widest, mut best_off) = (0usize, -1.0f64, f64::INFINITY);
        for i in 1..piece.len() {
            let gap = piece[i - 1].mtime_ms - piece[i].mtime_ms;
            let off = (i as f64 - middle).abs();
            if gap > widest || (gap == widest && off < best_off) {
                widest = gap;
                cut = i;
                best_off = off;
            }
        }
        if cut == 0 || widest <= 0.0 {
            break;
        }
        let mut piece = pieces.remove(wi);
        let tail = piece.split_off(cut);
        pieces.insert(wi, tail);
        pieces.insert(wi, piece);
    }
    pieces
}

fn shared_depth(a: &[&EngineFile], b: &[&EngineFile]) -> usize {
    let sa = segments(&a[0].dir);
    let sb = segments(&b[0].dir);
    sa.iter().zip(&sb).take_while(|(x, y)| x == y).count()
}

pub fn merge_to_block_cap<'a>(clusters: Vec<Cluster<'a>>, cap: f64, limit: f64) -> Vec<Cluster<'a>> {
    let mut out: Vec<Cluster> = clusters.into_iter().filter(|c| !c.is_empty()).collect();
    while out.len() as f64 > cap {
        let mut best: Option<(usize, usize)> = None;
        let (mut best_depth, mut best_size) = (-1isize, usize::MAX);
        for i in 0..out.len() {
            for j in i + 1..out.len() {
                let size = out[i].len() + out[j].len();
                if size as f64 > limit {
                    continue;
                }
                let depth = shared_depth(&out[i], &out[j]) as isize;
                if depth > best_depth || (depth == best_depth && size < best_size) {
                    best = Some((i, j));
                    best_depth = depth;
                    best_size = size;
                }
            }
        }
        let Some((a, b)) = best else { break };
        let mut merged = out[a].clone();
        merged.extend(out[b].iter().copied());
        let mut k = 0;
        out.retain(|_| {
            let keep = k != a && k != b;
            k += 1;
            keep
        });
        out.push(merged);
    }
    out
}

fn cluster_project_files<'a>(files: &[&'a EngineFile], gap: f64, t: &ClusteringTunables, root_depth: usize) -> Vec<Cluster<'a>> {
    let limit = concentration_limit(files.len(), t);
    let mut out = Vec::new();
    for cluster in absorb_small_clusters(cluster_by_gap(files, gap), t.min_files) {
        let cluster_limit =
            if is_bulk_cluster(&cluster, t) { limit.min(cluster.len() as f64 - 1.0) } else { limit };
        for piece in split_oversized_by_path(cluster, root_depth, cluster_limit) {
            out.extend(split_by_largest_gaps(piece, cluster_limit));
        }
    }
    merge_to_block_cap(out, t.max_blocks_per_project, limit)
}

/// Insertion-ordered map from block id to members.
#[derive(Default)]
struct Members<'a> {
    order: Vec<String>,
    map: HashMap<String, Cluster<'a>>,
}

impl<'a> Members<'a> {
    fn push(&mut self, id: &str, f: &'a EngineFile) {
        self.extend(id, std::iter::once(f));
    }
    fn extend(&mut self, id: &str, fs: impl IntoIterator<Item = &'a EngineFile>) {
        if !self.map.contains_key(id) {
            self.order.push(id.to_string());
        }
        self.map.entry(id.to_string()).or_default().extend(fs);
    }
    fn len(&self) -> usize {
        self.map.len()
    }
    fn iter(&self) -> impl Iterator<Item = (&String, &Cluster<'a>)> {
        self.order.iter().map(|k| (k, &self.map[k]))
    }
}

pub fn derive_blocks(
    project: &str,
    files: &[&EngineFile],
    prior: &[&PriorAssignment],
    known_blocks: &[&BlockRecord],
    t: &ClusteringTunables,
    now: f64,
) -> DerivedBlocks {
    let by_id: HashMap<&str, &BlockRecord> = known_blocks.iter().map(|b| (b.block_id.as_str(), *b)).collect();
    let prior_by_path: HashMap<&str, &PriorAssignment> = prior.iter().map(|p| (p.path.as_str(), *p)).collect();
    let mut by_path: HashMap<String, String> = HashMap::new();
    let root_depth = common_root_depth(files);

    // 1. Stability: unchanged files stay where they were.
    let mut pool = Vec::new();
    let mut members = Members::default();
    for f in files.iter().copied() {
        match prior_by_path.get(f.path.as_str()) {
            Some(p) if p.mtime_ms == f.mtime_ms && p.block_id.as_deref().is_some_and(|b| by_id.contains_key(b)) => {
                let target = resolve_merge(p.block_id.as_deref().unwrap(), &by_id);
                by_path.insert(f.path.clone(), target.clone());
                members.push(&target, f);
            }
            _ => pool.push(f),
        }
    }

    // 2. New or changed files join the nearest block within the gap.
    let gap = t.gap_hours * 3_600_000.0;
    let mut ranges: Vec<(String, f64, f64)> = members
        .iter()
        .map(|(id, m)| (id.clone(), min_of(m.iter().map(|x| x.mtime_ms)), max_of(m.iter().map(|x| x.mtime_ms))))
        .collect();
    let mut still_pool = Vec::new();
    for f in pool {
        let mut joined: Option<usize> = None;
        let mut best = f64::INFINITY;
        for (i, (_, lo, hi)) in ranges.iter().enumerate() {
            let dist = if f.mtime_ms >= *lo && f.mtime_ms <= *hi {
                0.0
            } else {
                (f.mtime_ms - lo).abs().min((f.mtime_ms - hi).abs())
            };
            if dist <= gap && dist < best {
                joined = Some(i);
                best = dist;
            }
        }
        match joined {
            Some(i) => {
                let id = ranges[i].0.clone();
                by_path.insert(f.path.clone(), id.clone());
                members.push(&id, f);
                ranges[i].1 = ranges[i].1.min(f.mtime_ms);
                ranges[i].2 = ranges[i].2.max(f.mtime_ms);
            }
            None => still_pool.push(f),
        }
    }

    // 3. Fresh clustering for the rest.
    for cluster in cluster_project_files(&still_pool, gap, t, root_depth) {
        let founder = cluster[cluster.len() - 1];
        let id = mint_id(project, founder);
        for f in &cluster {
            by_path.insert(f.path.clone(), id.clone());
        }
        members.extend(&id, cluster);
    }

    // 4. Adaptive cap: recluster everything with doubled gaps, adopting old
    //    ids by majority overlap.
    let mut effective = gap;
    let mut final_members = members;
    while final_members.len() as f64 > t.max_blocks_per_project {
        effective *= 2.0;
        let reclustered = cluster_project_files(files, effective, t, root_depth);
        let mut adopted = Members::default();
        for cluster in reclustered {
            let mut votes: Vec<(&str, usize)> = Vec::new();
            for f in &cluster {
                if let Some(old) = by_path.get(&f.path) {
                    match votes.iter_mut().find(|(k, _)| *k == old.as_str()) {
                        Some(v) => v.1 += 1,
                        None => votes.push((old.as_str(), 1)),
                    }
                }
            }
            let mut best: Option<&str> = None;
            let mut best_votes = 0;
            for (id, n) in votes {
                if n > best_votes {
                    best = Some(id);
                    best_votes = n;
                }
            }
            let founder = cluster[cluster.len() - 1];
            let id = match best {
                Some(b) if best_votes * 2 >= cluster.len() => b.to_string(),
                _ => mint_id(project, founder),
            };
            adopted.extend(&id, cluster);
        }
        if adopted.len() >= final_members.len() {
            final_members = adopted;
            break;
        }
        final_members = adopted;
        if effective > 365.0 * 24.0 * 3_600_000.0 {
            break;
        }
    }
    by_path.clear();
    for (id, m) in final_members.iter() {
        for f in m {
            by_path.insert(f.path.clone(), id.clone());
        }
    }

    // 5. Block records: known ids keep their name, new ids are named.
    let mut seen: HashSet<String> = HashSet::new();
    let mut blocks = Vec::new();
    let mut ordered: Vec<(&String, &Cluster)> = final_members.iter().collect();
    ordered.sort_by(|a, b| {
        max_of(a.1.iter().map(|f| f.mtime_ms))
            .partial_cmp(&max_of(b.1.iter().map(|f| f.mtime_ms)))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for (id, m) in ordered {
        let known = by_id.get(id.as_str());
        let name = match known {
            Some(k) => k.auto_name.clone(),
            None => pick_block_name(&block_name_candidates(m, root_depth, now), &seen),
        };
        seen.insert(name.clone());
        let times = || m.iter().map(|f| f.mtime_ms);
        let births = m.iter().map(|f| f.birthtime_ms.unwrap_or(f.mtime_ms));
        blocks.push(BlockRecord {
            block_id: id.clone(),
            project: project.to_string(),
            auto_name: name,
            custom_name: known.and_then(|k| k.custom_name.clone()),
            merged_into: known.and_then(|k| k.merged_into.clone()),
            created_at: match known {
                Some(k) => k.created_at.clone(),
                None => iso_from_ms(if m.is_empty() { now } else { min_of(births) }),
            },
            updated_at: iso_from_ms(if m.is_empty() { now } else { max_of(times()) }),
        });
    }
    DerivedBlocks { by_path, blocks }
}

#[cfg(test)]
mod tests {
    use super::super::assign::file;
    use super::super::rules::DEFAULT_CLUSTERING;
    use super::*;

    const H: f64 = 3_600_000.0;

    #[test]
    fn hash8_matches_javascript() {
        // Values computed with the TypeScript hash8 in node.
        assert_eq!(hash8(""), "000045h");
        assert_eq!(hash8("a"), "0003t1g");
        assert_eq!(hash8("Markie:/Users/k/notes/a.md:1700000000000"), "1mdpxqe");
        assert_eq!(hash8("é"), "0003sy4");
    }

    #[test]
    fn date_stamps_and_humanizing() {
        assert_eq!(strip_date_stamp("2026-08-26-organized-workspace-design"), "organized-workspace-design");
        assert_eq!(strip_date_stamp("notes-20260826"), "notes");
        assert_eq!(strip_date_stamp("2026-08-26"), "2026-08-26");
        assert_eq!(humanize_stem("release-notes_draft"), "Release notes draft");
        assert_eq!(humanize_stem("README"), "README");
        assert_eq!(humanize_stem("iOS-plan"), "iOS plan");
    }

    #[test]
    fn pick_names_fall_through_candidates() {
        let taken: HashSet<String> = ["docs".to_string()].into();
        assert_eq!(pick_block_name(&["docs".into(), "Plan".into()], &taken), "Plan");
        let taken: HashSet<String> = ["docs".to_string(), "docs (2)".to_string()].into();
        assert_eq!(pick_block_name(&["docs".into()], &taken), "docs (3)");
    }

    #[test]
    fn gap_clustering_and_stable_ids() {
        let files = [
            file("/p/docs/a.md", 100.0 * H),
            file("/p/docs/b.md", 101.0 * H),
            file("/p/notes/c.md", 300.0 * H),
            file("/p/notes/d.md", 301.0 * H),
        ];
        let refs: Vec<&EngineFile> = files.iter().collect();
        let d = derive_blocks("P", &refs, &[], &[], &DEFAULT_CLUSTERING, 0.0);
        assert_eq!(d.blocks.len(), 2);
        assert_eq!(d.by_path["/p/docs/a.md"], d.by_path["/p/docs/b.md"]);
        assert_ne!(d.by_path["/p/docs/a.md"], d.by_path["/p/notes/c.md"]);
        // Oldest block first, named after its folder.
        assert_eq!(d.blocks[0].auto_name, "docs");
        assert_eq!(d.blocks[1].auto_name, "notes");
        assert_eq!(d.blocks[0].block_id, mint_id("P", &files[0]));

        // A rerun with priors keeps ids; a new nearby file joins its block.
        let priors: Vec<PriorAssignment> = files
            .iter()
            .map(|f| PriorAssignment { path: f.path.clone(), block_id: Some(d.by_path[&f.path].clone()), mtime_ms: f.mtime_ms })
            .collect();
        let mut more = files.to_vec();
        more.push(file("/p/docs/e.md", 110.0 * H));
        let refs: Vec<&EngineFile> = more.iter().collect();
        let pr: Vec<&PriorAssignment> = priors.iter().collect();
        let kb: Vec<&BlockRecord> = d.blocks.iter().collect();
        let d2 = derive_blocks("P", &refs, &pr, &kb, &DEFAULT_CLUSTERING, 0.0);
        assert_eq!(d2.by_path["/p/docs/e.md"], d.by_path["/p/docs/a.md"]);
        assert_eq!(d2.blocks.len(), 2);
    }

    #[test]
    fn merges_route_members_to_the_target() {
        let files = [file("/p/a.md", 1.0 * H), file("/p/b.md", 100.0 * H)];
        let refs: Vec<&EngineFile> = files.iter().collect();
        let d = derive_blocks("P", &refs, &[], &[], &DEFAULT_CLUSTERING, 0.0);
        let (a, b) = (d.by_path["/p/a.md"].clone(), d.by_path["/p/b.md"].clone());
        let mut known = d.blocks.clone();
        known.iter_mut().find(|k| k.block_id == a).unwrap().merged_into = Some(b.clone());
        let priors: Vec<PriorAssignment> = files
            .iter()
            .map(|f| PriorAssignment { path: f.path.clone(), block_id: Some(d.by_path[&f.path].clone()), mtime_ms: f.mtime_ms })
            .collect();
        let pr: Vec<&PriorAssignment> = priors.iter().collect();
        let kb: Vec<&BlockRecord> = known.iter().collect();
        let d2 = derive_blocks("P", &refs, &pr, &kb, &DEFAULT_CLUSTERING, 0.0);
        assert_eq!(d2.by_path["/p/a.md"], b);
    }

    #[test]
    fn bulk_writes_split_by_path_and_caps_hold() {
        // A fresh clone: 120 files in three folders stamped within a minute.
        let files: Vec<EngineFile> = (0..120)
            .map(|i| file(&format!("/r/{}/f{i}.md", ["src", "docs", "tests"][i % 3]), 1000.0 * H + i as f64))
            .collect();
        let refs: Vec<&EngineFile> = files.iter().collect();
        let d = derive_blocks("R", &refs, &[], &[], &DEFAULT_CLUSTERING, 0.0);
        let mut names: Vec<_> = d.blocks.iter().map(|b| b.auto_name.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["docs", "src", "tests"]);
        // Concentration: no block may hold more than 40 % of a big project.
        let limit = concentration_limit(120, &DEFAULT_CLUSTERING);
        assert_eq!(limit, 48.0);
        assert_eq!(concentration_limit(5, &DEFAULT_CLUSTERING), f64::INFINITY);
    }

    #[test]
    fn largest_gap_split_cuts_even_runs_in_half() {
        let files: Vec<EngineFile> = (0..8).map(|i| file(&format!("/x/f{i}.md"), i as f64 * 10.0)).collect();
        let refs: Vec<&EngineFile> = files.iter().collect();
        let pieces = split_by_largest_gaps(refs, 4.0);
        assert_eq!(pieces.iter().map(Vec::len).collect::<Vec<_>>(), vec![4, 4]);
        let same: Vec<EngineFile> = (0..6).map(|i| file(&format!("/x/s{i}.md"), 5.0)).collect();
        let refs: Vec<&EngineFile> = same.iter().collect();
        assert_eq!(split_by_largest_gaps(refs, 2.0).len(), 1, "one instant cannot be split");
    }
}
