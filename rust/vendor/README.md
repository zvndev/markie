# Patched dependencies

Crates here replace their crates.io release through `[patch.crates-io]` in `rust/Cargo.toml`. Each is the published source with the tests and benches folders left out, plus the patch below. Keep each at the version gpui-kit pins (`=0.10.0` today). When gpui-kit moves to a new version, take the new release, apply the patch again or drop it if upstream has an equivalent, then remove the old copy.

## gpui-base 0.10.0

One change, in `src/input/editor/display_map/text_wrapper.rs` (`TextWrapper::update_lines`, marked "Markie patch"):

- Without soft wrap, the rows of a changed range are found in one pass over the rope's chunks with `memchr`, instead of one `slice_line` (a rope seek) per row. Markie opens files of 1 MB and more without soft wrap. At 100 MB (1.6 million lines) the old loop cost about one second on the first frame.
- The rows are the same as before. The test `unwrapped_rows_match_the_per_row_loop` checks them against the per-row loop, for line endings, empty lines, multibyte text, a text over many rope chunks, and edits.
- `memchr` is added to its dependencies. It was already in the lock file.

Run its test with `cargo test --manifest-path vendor/gpui-base/Cargo.toml --lib unwrapped_rows`.
