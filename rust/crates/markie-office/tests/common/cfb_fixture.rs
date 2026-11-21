//! Port of src/lib/office/cfb-test-fixtures.ts: synthetic bytes generated from
//! [MS-CFB] 2.2 to 2.7; no real or private documents.
#![allow(dead_code)]

pub const CFB_FREE: u32 = 0xffffffff;
pub const CFB_END: u32 = 0xfffffffe;

pub struct Fixture {
    pub bytes: Vec<u8>,
    pub sector_size: usize,
    pub fat_ids: Vec<usize>,
    pub difat_ids: Vec<usize>,
    pub directory_ids: Vec<usize>,
    pub mini_fat_ids: Vec<usize>,
    pub mini_root_ids: Vec<usize>,
    pub entry_offsets: Vec<usize>,
    pub stream_sectors: Vec<Vec<usize>>,
    pub stream_mini_sectors: Vec<Vec<usize>>,
}

impl Fixture {
    pub fn sector_offset(&self, id: usize) -> usize { (id + 1) * self.sector_size }
    pub fn w16(&mut self, at: usize, v: u16) { self.bytes[at..at + 2].copy_from_slice(&v.to_le_bytes()); }
    pub fn w32(&mut self, at: usize, v: u32) { self.bytes[at..at + 4].copy_from_slice(&v.to_le_bytes()); }
    pub fn set_fat(&mut self, id: usize, value: u32) {
        let per = self.sector_size / 4;
        let at = self.sector_offset(self.fat_ids[id / per]) + (id % per) * 4;
        self.w32(at, value);
    }
    pub fn set_mini_fat(&mut self, id: usize, value: u32) {
        let per = self.sector_size / 4;
        let at = self.sector_offset(self.mini_fat_ids[id / per]) + (id % per) * 4;
        self.w32(at, value);
    }
}

pub fn make_cfb(streams: &[(&str, Vec<u8>)], version: u16, difat: bool) -> Fixture {
    let sector_size = if version == 3 { 512 } else { 4096 };
    let directory_count = ((streams.len() + 1) * 128).div_ceil(sector_size);
    let mini_count: usize = streams.iter().filter(|s| !s.1.is_empty() && s.1.len() < 4096).map(|s| s.1.len().div_ceil(64)).sum();
    let mini_fat_count = (mini_count * 4).div_ceil(sector_size);
    let mini_root_count = (mini_count * 64).div_ceil(sector_size);
    let normal_count: usize = streams.iter().filter(|s| s.1.len() >= 4096).map(|s| s.1.len().div_ceil(sector_size)).sum();
    let difat_count = usize::from(difat);
    let mut fat_count = if difat { 110 } else { 1 };
    while fat_count * sector_size / 4 < fat_count + difat_count + directory_count + mini_fat_count + mini_root_count + normal_count { fat_count += 1; }
    assert!(fat_count <= 109 || difat, "Fixture requires DIFAT option.");
    let sector_count = fat_count + difat_count + directory_count + mini_fat_count + mini_root_count + normal_count;
    let ids = |at: usize, count: usize| (at..at + count).collect::<Vec<_>>();
    let mut f = Fixture {
        bytes: vec![0; (sector_count + 1) * sector_size], sector_size,
        fat_ids: ids(0, fat_count), difat_ids: ids(fat_count, difat_count),
        directory_ids: ids(fat_count + difat_count, directory_count),
        mini_fat_ids: ids(fat_count + difat_count + directory_count, mini_fat_count),
        mini_root_ids: ids(fat_count + difat_count + directory_count + mini_fat_count, mini_root_count),
        entry_offsets: vec![], stream_sectors: vec![vec![]; streams.len()], stream_mini_sectors: vec![vec![]; streams.len()],
    };
    f.bytes[..8].copy_from_slice(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    f.w16(24, 0x3e); f.w16(26, version); f.w16(28, 0xfffe); f.w16(30, if version == 3 { 9 } else { 12 }); f.w16(32, 6);
    f.w32(40, if version == 3 { 0 } else { directory_count as u32 }); f.w32(44, fat_count as u32); f.w32(48, f.directory_ids[0] as u32); f.w32(56, 4096);
    f.w32(60, f.mini_fat_ids.first().map_or(CFB_END, |v| *v as u32)); f.w32(64, mini_fat_count as u32);
    f.w32(68, f.difat_ids.first().map_or(CFB_END, |v| *v as u32)); f.w32(72, difat_count as u32);
    for i in 0..109 { let v = f.fat_ids.get(i).map_or(CFB_FREE, |v| *v as u32); f.w32(76 + i * 4, v); }
    for id in f.fat_ids.clone() { for i in (0..sector_size).step_by(4) { let at = f.sector_offset(id) + i; f.w32(at, CFB_FREE); } }
    let link = |f: &mut Fixture, chain: &[usize]| for (i, id) in chain.iter().enumerate() { f.set_fat(*id, chain.get(i + 1).map_or(CFB_END, |v| *v as u32)); };
    for id in f.fat_ids.clone() { f.set_fat(id, 0xfffffffd); }
    for id in f.difat_ids.clone() { f.set_fat(id, 0xfffffffc); }
    if difat_count > 0 {
        let at = f.sector_offset(f.difat_ids[0]);
        for i in 0..sector_size / 4 - 1 { let v = f.fat_ids.get(109 + i).map_or(CFB_FREE, |v| *v as u32); f.w32(at + i * 4, v); }
        f.w32(at + sector_size - 4, CFB_END);
    }
    let (d, m, r) = (f.directory_ids.clone(), f.mini_fat_ids.clone(), f.mini_root_ids.clone());
    link(&mut f, &d); link(&mut f, &m); link(&mut f, &r);
    for id in m.clone() { for i in (0..sector_size).step_by(4) { let at = f.sector_offset(id) + i; f.w32(at, CFB_FREE); } }
    f.entry_offsets = (0..directory_count * sector_size / 128).map(|i| f.sector_offset(d[i * 128 / sector_size]) + i * 128 % sector_size).collect();
    for at in f.entry_offsets.clone() { f.w32(at + 68, CFB_FREE); f.w32(at + 72, CFB_FREE); f.w32(at + 76, CFB_FREE); }
    let write_entry = |f: &mut Fixture, id: usize, name: &str, kind: u8, start: u32, size: usize| {
        let at = f.entry_offsets[id];
        let units: Vec<u16> = name.encode_utf16().collect();
        for (i, u) in units.iter().enumerate() { f.w16(at + i * 2, *u); }
        f.w16(at + 64, ((units.len() + 1) * 2) as u16); f.bytes[at + 66] = kind; f.bytes[at + 67] = 1;
        f.w32(at + 116, start); f.w32(at + 120, size as u32);
    };
    write_entry(&mut f, 0, "Root Entry", 5, r.first().map_or(CFB_END, |v| *v as u32), mini_count * 64);
    let mut normal_at = fat_count + difat_count + directory_count + mini_fat_count + mini_root_count;
    let mut mini_at = 0;
    for (index, (name, data)) in streams.iter().enumerate() {
        let mut start = CFB_END;
        if data.len() >= 4096 {
            let chain = ids(normal_at, data.len().div_ceil(sector_size)); normal_at += chain.len();
            link(&mut f, &chain); start = chain[0] as u32;
            for (i, id) in chain.iter().enumerate() {
                let piece = &data[i * sector_size..((i + 1) * sector_size).min(data.len())];
                let at = f.sector_offset(*id); f.bytes[at..at + piece.len()].copy_from_slice(piece);
            }
            f.stream_sectors[index] = chain;
        } else if !data.is_empty() {
            let chain = ids(mini_at, data.len().div_ceil(64)); mini_at += chain.len();
            start = chain[0] as u32;
            for (i, id) in chain.iter().enumerate() {
                f.set_mini_fat(*id, chain.get(i + 1).map_or(CFB_END, |v| *v as u32));
                let piece = &data[i * 64..((i + 1) * 64).min(data.len())];
                let at = f.sector_offset(r[id * 64 / sector_size]) + id * 64 % sector_size;
                f.bytes[at..at + piece.len()].copy_from_slice(piece);
            }
            f.stream_mini_sectors[index] = chain;
        }
        write_entry(&mut f, index + 1, name, 2, start, data.len());
    }
    // Balanced red-black sibling tree: deepest incomplete level red, preceding levels black.
    let mut ordered: Vec<(String, usize)> = streams.iter().enumerate().map(|(i, s)| (s.0.to_uppercase(), i + 1)).collect();
    ordered.sort_by(|a, b| a.0.len().cmp(&b.0.len()).then(a.0.cmp(&b.0)));
    let red_level = (streams.len() + 1).ilog2() as usize;
    fn tree(f: &mut Fixture, ordered: &[(String, usize)], lo: isize, hi: isize, depth: usize, red: usize) -> u32 {
        if lo > hi { return CFB_FREE; }
        let mid = (lo + hi).div_euclid(2); let id = ordered[mid as usize].1; let at = f.entry_offsets[id];
        f.bytes[at + 67] = if depth == red { 0 } else { 1 };
        let l = tree(f, ordered, lo, mid - 1, depth + 1, red); f.w32(at + 68, l);
        let rr = tree(f, ordered, mid + 1, hi, depth + 1, red); f.w32(at + 72, rr);
        id as u32
    }
    let root = tree(&mut f, &ordered, 0, streams.len() as isize - 1, 0, red_level);
    let at = f.entry_offsets[0]; f.w32(at + 76, root);
    f
}
