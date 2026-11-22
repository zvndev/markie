---
title: Everything
tags: [export, fixture]
---

# Export fixture

A paragraph with **bold**, *italic*, ***both***, ~~struck~~, `inline code`, and a [link](https://markiedocs.com "Markie"). An autolink https://example.com/path?q=1 and <https://example.org>. A footnote reference.[^1]

## Lists

- First item
- Second item with **bold**
  - Nested item
    - Deeper item
- Third

1. One
2. Two
   1. Two point one
3. Three

5. Starts at five
6. Six

- [ ] Open task
- [x] Done task

### Quote and rule

> A quote with *emphasis*.
>
> Second paragraph in the quote.

---

#### Code

```js
// A comment
const answer = 42;
function greet(name) { return `Hello, ${name}`; }
```

```python
def add(a, b):
    """Add two numbers."""
    return a + b  # sum
```

```
plain block without a language
```

##### Table

| Name | Count | Note |
|:-----|------:|:----:|
| Apples | 3 | *fresh* |
| Pears | 12 | `code` |

###### Math

Inline math $E = mc^2$ and a price of $5 and $10 stays text.

$$
\int_0^1 x^2 \, dx = \frac{1}{3}
$$

Hard break at the end of this line  
and the next line.

Raw HTML: <mark>highlight</mark>, <u>underline</u>, <span style="color: #dc2626">red text</span>, H<sub>2</sub>O and x<sup>2</sup>, <kbd>Cmd</kbd>.

<p style="text-align: center">Centred paragraph</p>

<script>alert("no")</script>
<style>body { display: none }</style>
<div style="position: fixed; inset: 0; z-index: 99; color: #16a34a">Contained style</div>

[bad link](javascript:alert(1))

![A picture](pic.png)

![Wide picture](wide.png)

https://youtu.be/dQw4w9WgXcQ

https://vimeo.com/123456789

![A clip](clip.mp4)

[^1]: The footnote text.
