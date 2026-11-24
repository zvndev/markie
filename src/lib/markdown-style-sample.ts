// One document that uses every element a Markdown style can change. The style
// editor draws it as its live preview, and scripts/markdown-style-gallery.mjs
// draws it in every preset. It is Markdown, rendered by the app's own
// pipeline (markdown-html.ts), so what the preview shows is what a real
// document gets.

// A small drawn landscape, inline so the sample needs no file and no network.
const PICTURE =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NDAiIGhlaWdodD0iMjYwIiB2aWV3Qm94PSIwIDAgNjQwIDI2MCI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJzIiB4MT0iMCIgeTE9IjAiIHgyPSIwIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjOGZiOGRlIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjZjNkOWIxIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHJlY3Qgd2lkdGg9IjY0MCIgaGVpZ2h0PSIyNjAiIGZpbGw9InVybCgjcykiLz48Y2lyY2xlIGN4PSI1MDAiIGN5PSI3OCIgcj0iMzQiIGZpbGw9IiNmZmY0ZDYiLz48cGF0aCBkPSJNMCAxOTAgTDEyMCAxMTAgTDIxMCAxNzAgTDMzMCA4MCBMNDcwIDE4MCBMNTYwIDEzMCBMNjQwIDE3NSBMNjQwIDI2MCBMMCAyNjBaIiBmaWxsPSIjNWQ3YThjIi8+PHBhdGggZD0iTTAgMjIwIEwxNTAgMTY1IEwzMDAgMjE1IEw0NTAgMTcwIEw2NDAgMjI1IEw2NDAgMjYwIEwwIDI2MFoiIGZpbGw9IiMzNDQ5NWEiLz48L3N2Zz4=";

export const MARKDOWN_STYLE_SAMPLE = `# The Lighthouse Keeper's Handbook

A working guide to the light at Cape Arden, written for whoever takes the next watch. It covers the daily round, the log, and what to do when the weather turns. Start with [the daily round](#the-daily-round) if you only have an hour.

Paragraphs follow one another like this one does. The second paragraph of a run shows how they separate: by a gap, by an indent, or squared off at both edges. Words can be **strong**, *emphasised*, ~~struck out~~ or set as \`inline code\`.

## The daily round

The lamp is lit half an hour before sunset and put out half an hour after sunrise. Between the two there are three jobs.

### Before dusk

- Trim the wick and fill the reservoir
- Clean the lens with the soft cloth only
  - Never use the brass polish on glass
  - Work from the centre outward
    - One pass, no circles
- Wind the clockwork that turns the lens

### Through the night

1. Check the flame at each hour
2. Enter the weather in the log
   1. Wind direction and force
   2. Visibility in miles
      1. Note fog separately
3. Sound the horn when visibility drops below one mile

#### Before you go off watch

- [x] Lamp out and wick trimmed
- [x] Log signed
- [ ] Oil ordered for next month
- [ ] Shutters latched on the seaward side

## The log

Every watch ends with a line in the log. Keep it short and keep it true.

| Date | Wind | Visibility | Remarks |
| --- | --- | ---: | --- |
| 3 March | NW 5 | 12 mi | Clear, two schooners passed |
| 4 March | W 7 | 4 mi | Squalls after midnight |
| 5 March | SW 8 | 1 mi | Horn sounded from 02:10 |
| 6 March | S 3 | 9 mi | Fog bank offshore at dawn |

> A light that is seen every night is noticed only on the night it fails.
>
> Keep it burning.

---

## Signals

The horn is driven from the engine room. To start the compressor, run:

\`\`\`sh
# Open the air valve, then start the engine
./compressor start --pressure 60
tail -f /var/log/horn.log
\`\`\`

Set the timer with \`horn --every 30s\` and leave it until the fog lifts.

![The cape at first light](${PICTURE})
*The cape at first light, seen from the lower gallery.*

##### Further reading

See the [Admiralty List of Lights](https://example.com/lights) for the characteristics of neighbouring stations.

###### Revised each spring
`;
