# Math in export

Inline math sits in a line of text: $E = mc^2$, $a^2 + b^2 = c^2$, $x_{i,j}$, $\frac{1}{2}$ and $\sqrt{2}$. A price of $5 and $10 stays text.

Greek letters: $\alpha, \beta, \gamma, \delta, \epsilon, \varepsilon, \zeta, \eta, \theta, \vartheta, \lambda, \mu, \pi, \rho, \sigma, \tau, \phi, \varphi, \chi, \psi, \omega$ and $\Gamma, \Delta, \Theta, \Lambda, \Xi, \Pi, \Sigma, \Phi, \Psi, \Omega$.

Accents: $\hat{x}$, $\bar{y}$, $\vec{v}$, $\dot{a}$, $\ddot{b}$, $\tilde{n}$, $\acute{e}$, $\grave{a}$, $\breve{u}$, $\check{c}$, $\widehat{xyz}$, $\widetilde{abc}$, $\overline{AB}$ and $\underline{cd}$.

## Fractions and roots

$$
\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$

$$
\cfrac{1}{1 + \cfrac{1}{1 + \cfrac{1}{x}}} = \dfrac{a}{b} + \tfrac{c}{d} + \binom{n}{k} + \sqrt[3]{x^3 + y^3}
$$

## Sums, products and integrals

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}, \qquad \prod_{k=1}^{\infty} \left(1 - \frac{1}{p_k^s}\right)^{-1} = \zeta(s)
$$

$$
\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}, \qquad \oint_C \mathbf{F} \cdot d\mathbf{r} = \iint_S (\nabla \times \mathbf{F}) \cdot d\mathbf{S}
$$

Inline big operators: $\sum_{n=1}^\infty \frac{1}{n^2} = \frac{\pi^2}{6}$ and $\lim_{x \to 0} \frac{\sin x}{x} = 1$.

## Matrices

$$
A = \begin{pmatrix} a_{11} & a_{12} & a_{13} \\ a_{21} & a_{22} & a_{23} \\ a_{31} & a_{32} & a_{33} \end{pmatrix}, \quad \det \begin{vmatrix} a & b \\ c & d \end{vmatrix} = ad - bc
$$

$$
\begin{bmatrix} 1 & 0 \\ 0 & 1 \end{bmatrix} \begin{Bmatrix} x \\ y \end{Bmatrix} = \begin{matrix} x \\ y \end{matrix}
$$

## Cases, alignment and delimiters

$$
f(x) = \begin{cases} x^2 & \text{if } x \ge 0 \\ -x & \text{otherwise} \end{cases}
$$

$$
\begin{aligned} (a + b)^2 &= a^2 + 2ab + b^2 \\ &\le 2(a^2 + b^2) \end{aligned}
$$

$$
\left\langle \psi \middle| \hat{H} \middle| \psi \right\rangle, \quad \left\lfloor \frac{n}{2} \right\rfloor, \quad \left\lceil \log_2 n \right\rceil, \quad \Bigg( \bigg( \Big( \big( x \big) \Big) \bigg) \Bigg)
$$

## Fonts, arrows and decorations

$$
\mathbb{R}^n, \mathcal{L}, \mathfrak{g}, \mathrm{d}x, \mathit{if}, \boldsymbol{\beta}, \mathsf{T}, \mathtt{mono}, \quad A \xrightarrow{f} B \Rightarrow C \iff D, \quad \overbrace{a + \cdots + a}^{n} = \underbrace{b + b}_{2}
$$

Arrows and relations inline: $x \to y$, $a \mapsto b$, $p \implies q$, $A \subseteq B$, $x \in \mathbb{N}$, $a \approx b$, $c \neq d$, $\nabla f$, $\partial_t u$ and $\hbar\omega$.

```math
\mathcal{F}\{f\}(\xi) = \int_{-\infty}^{\infty} f(x)\, e^{-2\pi i x \xi} \, dx
```

A formula KaTeX cannot parse stays as its source: $\frac{1}{$ and $$\begin{matrix} a \end{pmatrix}$$ in a line.
