//! Formulas typical of Markie documents must all render, and every SVG must
//! parse with the same usvg GPUI rasterizes images with (gpui-pre 0.3.12 uses
//! usvg/resvg 0.46), with a non-zero size and glyphs as paths (no fonts).

use std::time::Instant;

use markie_math::{MathCache, MathError, MathStyle, render, strip_delimiters};

/// (TeX body, display). The first block comes from markie-rich's interop
/// cases and tests; the rest covers what Markie docs and KaTeX users write.
const FORMULAS: &[(&str, bool)] = &[
    // markie-rich/interop/cases.json and tests/edit.rs
    (r"\frac{a}{b} \, dx", true),
    (r"e^{i\pi}", false),
    ("a = b\n  + c", true),
    (r"e^{i\pi} + 1 = 0", false),
    ("x", true),
    ("e", false),
    ("x", false),
    ("y", false),
    // fractions, roots, scripts
    (r"\frac{1}{2}", false),
    (r"\dfrac{n(n+1)}{2}", true),
    (r"\tfrac{3}{4}", false),
    (r"\sqrt{x^2 + y^2}", false),
    (r"\sqrt[3]{8} = 2", false),
    (r"x_{i,j}^{2}", false),
    (r"a_1, a_2, \ldots, a_n", false),
    (r"\binom{n}{k} = \frac{n!}{k!(n-k)!}", true),
    // sums, products, integrals, limits
    (r"\sum_{i=1}^{n} i = \frac{n(n+1)}{2}", true),
    (r"\prod_{k=1}^{n} k = n!", true),
    (r"\int_0^\infty e^{-x^2} \, dx = \frac{\sqrt{\pi}}{2}", true),
    (r"\iint_D f(x,y) \, dA", true),
    (r"\oint_C \mathbf{F} \cdot d\mathbf{r}", true),
    (r"\lim_{x \to 0} \frac{\sin x}{x} = 1", true),
    (r"\sum_{n=0}^{\infty} \frac{x^n}{n!}", false),
    // matrices and environments
    (r"\begin{pmatrix} a & b \\ c & d \end{pmatrix}", true),
    (r"\begin{bmatrix} 1 & 0 \\ 0 & 1 \end{bmatrix}", true),
    (r"\begin{vmatrix} a & b \\ c & d \end{vmatrix} = ad - bc", true),
    (r"\begin{matrix} x & y \\ z & w \end{matrix}", true),
    (r"A = \begin{pmatrix} 1 & 2 & 3 \\ 4 & 5 & 6 \\ 7 & 8 & 9 \end{pmatrix}", true),
    ("\\begin{aligned}\n  f(x) &= (x+1)^2 \\\\\n       &= x^2 + 2x + 1\n\\end{aligned}", true),
    (r"f(x) = \begin{cases} x^2 & x \ge 0 \\ -x & x < 0 \end{cases}", true),
    (r"\begin{array}{cc} 1 & 2 \\ 3 & 4 \end{array}", true),
    // text and fonts
    (r"\text{if } x > 0 \text{ then } y = 1", false),
    (r"\mathbb{R}^n \to \mathbb{C}", false),
    (r"\mathbb{N} \subset \mathbb{Z} \subset \mathbb{Q}", false),
    (r"\mathcal{O}(n \log n)", false),
    (r"\mathrm{d}x", false),
    (r"\mathbf{v} \cdot \mathbf{w}", false),
    (r"\mathit{diff}", false),
    (r"\operatorname{argmax}_{x} f(x)", false),
    (r"\operatorname{tr}(A)", false),
    (r"\textbf{bold} \quad \textit{italic}", false),
    // Greek and symbols
    (r"\alpha + \beta = \gamma", false),
    (r"\Gamma(n) = (n-1)!", false),
    (r"\Delta x \approx \epsilon", false),
    (r"\varphi, \phi, \vartheta, \theta, \omega, \Omega", false),
    (r"\forall x \in A, \exists y \notin B", false),
    (r"a \leq b \neq c \geq d", false),
    (r"x \Rightarrow y \iff z", false),
    (r"\infty \pm \partial \nabla", false),
    // accents and decorations
    (r"\hat{x} + \bar{y} + \tilde{z} + \vec{v} + \dot{a} + \ddot{b}", false),
    (r"\overline{AB}", false),
    (r"\underline{x}", false),
    (r"\widehat{abc}", false),
    (r"\overbrace{a+b}^{2}", true),
    (r"\underbrace{1 + 1 + \cdots + 1}_{n}", true),
    // delimiters
    (r"\left( \frac{a}{b} \right)", true),
    (r"\left[ x \right]", false),
    (r"\left\{ x \mid x > 0 \right\}", false),
    (r"\left| x \right|", false),
    (r"\langle u, v \rangle", false),
    (r"\lVert x \rVert_2", false),
    (r"\lfloor x \rfloor + \lceil y \rceil", false),
    (r"\bigl( x \bigr)", false),
    // misc
    (r"E = mc^2", false),
    (r"a \equiv b \pmod{n}", false),
    (r"x \bmod y", false),
    (r"f'(x) = \frac{d}{dx} f(x)", false),
    (r"\frac{\partial^2 u}{\partial t^2} = c^2 \nabla^2 u", true),
    (r"P(A \mid B) = \frac{P(B \mid A) P(A)}{P(B)}", true),
    (r"\mathbb{E}[X] = \sum_x x \, p(x)", false),
    (r"\boxed{x = 1}", false),
    (r"\color{red} x", false),
    (r"x \xrightarrow{f} y", false),
    (r"\displaystyle \sum_{i} x_i", false),
    (r"{a \over b}", false),
    (r"\stackrel{?}{=}", false),
    (r"\not\equiv", false),
    // Typst 0.15 symbol renames that the patched spec maps (see src/spec.rs)
    (r"A \cap B \cup C", false),
    (r"\bigcap_{i} A_i", true),
    (r"\partial_x f", false),
    (r"a \oplus b \otimes c \odot d", false),
    (r"\bigoplus_{i=1}^n V_i", true),
    (r"\hbar \omega", false),
    (r"\llbracket x \rrbracket", false),
    (r"\left\langle \psi \right\rangle", false),
    (r"\bra{\psi} \ket{\phi}", false),
    (r"\begin{Vmatrix} a & b \\ c & d \end{Vmatrix}", true),
    (r"a \gtrapprox b \gtreqqless c", false),
    (r"\argmax_{\theta} L(\theta)", true),
    (r"\mho", false),
    // added to the spec from the KaTeX command probe
    (r"\mathscr{L} \mapsfrom x \shortmid y", false),
    // KaTeX extras that mitex handles
    (r"\color{#ff0000} x + \textcolor{blue}{y}", false),
    (r"\newcommand{\R}{\mathbb{R}} f: \R \to \R", false),
    ("\\begin{align} a &= b \\\\ c &= d \\end{align}", true),
    (r"\operatorname*{lim}_{x \to 0} f", true),
    (r"\text{café, naïve}", false),
    (r"\begin{pmatrix*} 1 & -1 \\ -1 & 1 \end{pmatrix*}", true),
    (r"|x| = \begin{dcases} x & x \ge 0 \\ -x & x < 0 \end{dcases}", true),
];

fn style() -> MathStyle {
    MathStyle { color: [30, 30, 30, 255], font_size_pt: 16.0 }
}

fn check_svg(tex: &str, svg: &str) {
    let opts = usvg::Options::default();
    let tree = usvg::Tree::from_str(svg, &opts).unwrap_or_else(|e| panic!("usvg rejected SVG for {tex:?}: {e}"));
    let size = tree.size();
    assert!(size.width() > 0.0 && size.height() > 0.0, "zero size SVG for {tex:?}");
    assert!(tree.root().has_children(), "empty SVG for {tex:?}");
    assert!(!svg.contains("<text"), "SVG for {tex:?} uses <text>, which needs fonts");
}

#[test]
fn typical_formulas_render_to_valid_svg() {
    assert!(FORMULAS.len() >= 40);
    let mut failures = Vec::new();
    let mut times = Vec::new();
    markie_math::warm_up();
    for &(tex, display) in FORMULAS {
        let t0 = Instant::now();
        match render(tex, display, &style()) {
            Ok(r) => {
                times.push(t0.elapsed());
                assert!(r.width_pt > 0.0 && r.height_pt > 0.0, "{tex:?}");
                assert!(r.baseline_pt >= 0.0 && r.baseline_pt <= r.height_pt, "{tex:?}");
                check_svg(tex, &r.svg);
            }
            Err(e) => failures.push(format!("{tex:?}: {e}")),
        }
    }
    times.sort();
    if !times.is_empty() {
        eprintln!(
            "{} formulas, median {:?}, max {:?}",
            times.len(),
            times[times.len() / 2],
            times[times.len() - 1]
        );
    }
    assert!(failures.is_empty(), "failed formulas:\n{}", failures.join("\n"));
}

#[test]
fn errors_are_values() {
    for bad in [r"\notacommand{x}", r"\frac{", r"\left( x", "}"] {
        let r = render(bad, false, &style());
        assert!(r.is_err(), "{bad:?} should fail, got {:?}", r.map(|r| r.width_pt));
    }
    assert_eq!(render("  ", false, &style()), Err(MathError::Empty));
    // mitex is lenient where KaTeX is strict: these still render. Pinned here
    // so a behaviour change is noticed (see MATH.md, known gaps).
    for lenient in [r"\begin{pmatrix} 1 & 2", r"x^"] {
        assert!(render(lenient, false, &style()).is_ok(), "{lenient:?}");
    }
}

#[test]
fn baseline_sits_inside_for_descenders_and_fractions() {
    let s = style();
    let x = render("x", false, &s).unwrap();
    let y = render("y", false, &s).unwrap();
    let frac = render(r"\frac{a}{b}", false, &s).unwrap();
    // `y` descends below the baseline, `x` barely does.
    assert!(y.height_pt - y.baseline_pt > 2.0);
    assert!(x.height_pt - x.baseline_pt < 1.0);
    // An inline fraction straddles the baseline.
    assert!(frac.baseline_pt > 3.0 && frac.height_pt - frac.baseline_pt > 3.0);
    // Display style is taller than inline for the same source.
    let inline = render(r"\sum_{i=1}^n i", false, &s).unwrap();
    let display = render(r"\sum_{i=1}^n i", true, &s).unwrap();
    assert!(display.height_pt > inline.height_pt);
}

#[test]
fn style_changes_color_and_size() {
    let small = render("x+y", false, &MathStyle { color: [255, 0, 0, 255], font_size_pt: 10.0 }).unwrap();
    let big = render("x+y", false, &MathStyle { color: [255, 0, 0, 255], font_size_pt: 20.0 }).unwrap();
    assert!((big.width_pt / small.width_pt - 2.0).abs() < 0.05);
    assert!(small.svg.contains("#ff0000"), "color not applied: {}", &small.svg[..small.svg.len().min(400)]);
    // Bad sizes fall back instead of failing.
    assert!(render("x", false, &MathStyle { color: [0, 0, 0, 255], font_size_pt: f32::NAN }).is_ok());
}

#[test]
fn cache_hits_and_bounds() {
    let cache = MathCache::new(3);
    let s = style();
    let a = cache.get("a^2", false, &s);
    let a2 = cache.get("a^2", false, &s);
    assert!(std::sync::Arc::ptr_eq(&a, &a2));
    assert_eq!(cache.len(), 1);
    cache.get("a^2", true, &s);
    cache.get("a^2", false, &MathStyle { font_size_pt: 12.0, ..s });
    assert_eq!(cache.len(), 3);
    cache.get("b", false, &s);
    assert!(cache.len() <= 3);
    assert!(cache.get(r"\bad", false, &s).is_err());
}

#[test]
fn renders_from_many_threads() {
    let handles: Vec<_> = (0..8)
        .map(|i| {
            std::thread::spawn(move || {
                for &(tex, display) in FORMULAS.iter().skip(i).step_by(4) {
                    markie_math::render_cached(tex, display, &style()).as_ref().as_ref().unwrap();
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
}

#[test]
fn strip_then_render_markdown_sources() {
    for src in ["$e^{i\\pi}$", "$$\n\\frac{a}{b} \\, dx\n$$", "$$\na = b\n  + c\n$$", "$x$"] {
        let (tex, display) = strip_delimiters(src).unwrap();
        render(tex, display, &style()).unwrap();
    }
}

/// Rasterize the way GPUI does (`usvg::Tree::from_data` then `resvg::render`,
/// see gpui-pre 0.3.12 `svg_renderer.rs`) and check real pixels in the asked
/// color come out, with no font support at all.
#[test]
fn rasterizes_like_gpui_without_fonts() {
    let style = MathStyle { color: [200, 20, 40, 255], font_size_pt: 16.0 };
    let r = render(r"\int_0^1 x^2 \, dx = \frac{1}{3}", true, &style).unwrap();
    // usvg is built without its `text` feature here, so it has no font
    // support at all: any glyph that rendered came from a path.
    let opts = usvg::Options::default();
    let tree = usvg::Tree::from_data(r.svg.as_bytes(), &opts).unwrap();
    let scale = 2.0;
    let size = tree.size().to_int_size().scale_by(scale).unwrap();
    let mut pixmap = resvg::tiny_skia::Pixmap::new(size.width(), size.height()).unwrap();
    resvg::render(&tree, resvg::tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    let opaque: Vec<_> = pixmap.pixels().iter().filter(|p| p.alpha() == 255).collect();
    assert!(opaque.len() > 200, "only {} opaque pixels", opaque.len());
    let p = opaque[0].demultiply();
    assert_eq!((p.red(), p.green(), p.blue()), (200, 20, 40));
    // usvg reads the pt size as px * 4/3; the editor should size the image
    // from width_pt/height_pt, not from the rasterized pixmap.
    assert!((tree.size().width() - r.width_pt * 4.0 / 3.0).abs() < 0.5);
}
