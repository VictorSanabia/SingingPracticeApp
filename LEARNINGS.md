# Learnings

Running notes on things we figured out while building this app. Separate from `ANNOTATION.md` (which is the user-facing notation spec) — this is the technical / music-theory / process scratchpad.

---

## Music theory

### 6/8 and compound meters
6/8 is compound duple: 6 eighth notes per measure, 2 felt beats (each a dotted quarter). Singers don't count "1 2 3 4 5 6" — that loses the pulse. Three common counting systems:
- `1 & a   2 & a` — default for singing, preserves the 2-pulse feel
- `1 la li   2 la li` — Gordon/Kodály syllables, common in choral training
- `1 2 3 4 5 6` — only at slow tempos when every eighth genuinely matters

App convention: in compound meters the only digit marker is `2` (second dotted-quarter pulse); sub-beat positions use `&` and `a`. See `ANNOTATION.md` for the full spec. The OMR beat-marker generator needs the time signature to pick between simple-meter digits and compound-meter `& a`.

### Enharmonic conventions (flats vs sharps)
Note name depends on the key signature, not just pitch class:
- Flat-major keys: F, Bb, Eb, Ab, Db, Gb → use flats (Bb, not A#)
- Flat-minor keys: Dm, Gm, Cm, Fm, Bbm, Ebm → use flats
- Everything else → sharps

Implemented in `App.jsx` via `FLAT_MAJOR_ROOTS`, `FLAT_MINOR_ROOTS`, `usesFlats()`, `pcName()`. Detected key is the source of truth — fretboard dot labels, chord names, scale notes all flow through `pcName(pc, useFlatsForKey)`.

### Diatonic fallback chords
When no chord chart is available, we show the diatonic triads for the detected key:
- Major: I, IV, V, vi (e.g. C major → C, F, G, Am)
- Minor: i, iv, v, VII, III, VI (e.g. A minor → Am, Dm, Em, G, C, F)

This covers ~95% of pop-song chord vocabulary. Used by `diatonicChords()` and rendered by `ChordRail` when per-note chord data is absent.

---

## PDF extraction

### Image-only PDFs have no text layer
`pdfjs-dist` returns `rawItems: 0` when the PDF is a scan or rendered image — no amount of regex tweaking can recover text that isn't there. Confirmation signal: user can't highlight text in the PDF viewer. Surfaced in-app via the chartWarning banner. Future fix would need OCR over rendered page images (Tesseract.js in browser, or backend pipeline).

### Chord/lyric alignment via x-coordinates
PDFs don't tag rows as "chord" or "lyric" — we infer from content. The chord row sits above a lyric row, and chord names align horizontally with the syllable they belong to. Algorithm: group text items by y-coord into rows, classify each row, then pair chord rows with the next lyric row within 300pt on the same page. X-coord interpolation maps each lyric to a beat fraction within its bar.

### Music-engraving font glyphs as anchors
Notation rows are detected by characters like `Ï` and `Î` from the music font. These rows themselves are skipped (they're the staff, not text), but they anchor the 80pt proximity filter that kills page headers and copyright text.

---

## OMR (Audiveris)

### Beat info comes from `note.beat` + `note.measure`
The OMR pipeline emits per-note beat positions. `processLyrics` walks lyric-bearing notes, rounds the beat to an integer, and if it falls cleanly on beat 2, 3, or 4 of its measure, emits a beat marker. Dedupe key: `"${measure}-${beat}"` — multiple syllables on the same off-beat shouldn't all get a marker.

### Time signature isn't currently propagated
The beat-marker generator assumes simple 4/4-style counting. For 6/8 songs (Fix You, etc.) we'd need to detect or pass the time signature through and switch the marker emission rule. Not yet implemented.

---

## Guitar rendering

### Tabs ≠ chord diagrams
First attempt rendered chord-shape boxes labeled "tabs". Actual guitar tablature is a 6-line horizontal staff with fret numbers placed left-to-right in time order. Built `TabStaff` as a separate component from `ChordDiagram`. Both are useful — chord diagrams for strumming reference, tabs for note-by-note picking.

### Tabs need to convey timing
Equal-width tab columns lose rhythmic info. Fixes layered in:
- Column widths proportional to note duration (longer notes = wider column)
- Sustain dashes drawn from fret number to end of column on the same string
- Duration letter under each column (`w`, `h`, `q`, `e`, `s`, dotted variants via `q.`)

### Fretboard scale highlighting
Showing all scale notes equally was visually noisy. Greyed out everything except the current pitch — current note is orange, others are nearly black. Root notes get a slightly lighter stroke as a secondary cue.

---

## Process / tooling

### Port-killing on restart (Windows)
`Get-NetTCPConnection -LocalPort 5173,5001 | Stop-Process -Id _.OwningProcess -Force` reliably frees the dev ports without needing to know PIDs. Faster than `taskkill /F /IM node.exe` which nukes unrelated node processes.

### Auto-zoom for resolution scaling
The app is designed at a 1600px-wide canvas. Rather than refactor every fixed px value to fluid units (`clamp`, `rem`, `vw`), we use the CSS `zoom` property at the document root, scaled by `window.innerWidth / 1600`. So a 1280px laptop renders at 80% zoom, a 960px window at 60%, etc. — same content, just smaller.

Why `zoom` and not `transform: scale()`:
- `zoom` changes the effective coordinate system, so `useSize()` and ResizeObserver still report correct dimensions to child components. With `transform: scale()`, child components measure the pre-scale size and lay themselves out wrong.
- `zoom` is non-standard but supported in all modern browsers (Chromium, Safari, Firefox 126+).

This is a hack — the proper fix is fluid units everywhere. But the layout is still changing weekly, so refactoring sizes now would mean redoing them. Wired in `App.jsx` near the top-level `useEffect`s. Removable later when fluid units are in place.

### Responsive layout: scroll, don't crush
The 3-column layout has fixed widths/min-widths per column (left 30%/min 260, right 36%/min 320). When a user moves to a smaller screen, the right column's stacked widgets (ChordRail / Sheet / Tabs / Fretboard) don't auto-shrink vertically — each component has its own intrinsic height. Original behavior was `overflow: hidden` on the column, which clipped the bottom widget. Fix: switch to `overflowY: auto` so the column scrolls when content exceeds viewport. Don't try to flex-distribute vertical space — the widgets read poorly when squished.

### Section labels use one shared component
`SectionLabel` (defined just above `useSize`) is a tiny uppercase 10px caption used above each panel in all three columns. Keep all section labels going through it so spacing/typography stay consistent — don't inline new `<div style={{fontSize:10,...}}>` headers.

### Vite HMR vs hard reload
Most edits hot-reload fine, but changes to top-level constant dictionaries (`CHORD_SHAPES`, `CHROMATIC`) sometimes need a hard reload to take effect. If a change "isn't showing up", try Ctrl+Shift+R before assuming the code is wrong.

---

## Lyric-to-note assignment (the `assignLyricsFromChordPairs` saga)

### Lead-sheet reading rule: last syllable before the note, NOT nearest
A singer reading a lead sheet assigns each note to the LAST syllable whose x ≤ the note's x — never the nearest one by absolute distance. Notes that sit in blank space between two syllables belong to the PREVIOUS syllable (melisma extension), not the next syllable that's coming up. "Nearest" intuitively feels right but gives wrong results: a blank-space note 5pt away from the upcoming syllable but 30pt past the previous one still belongs to the previous syllable. Implemented as `claim-then-fill` in `assignLyricsFromChordPairs`.

### `claim-then-fill` beats `walk-forward`
First walk-forward implementation iterated per-note: each note found the last syllable with x ≤ note.x. Problem: when two syllables both fall before the same note (e.g. "Just" at x=150 and "when" at x=176 with note at x=183), the rule picks the LATER eligible one ("when"), losing "Just". Fix: iterate per-SYLLABLE instead. Each syllable claims the first unclaimed note whose nx ≥ its x, with cursor advancing monotonically. Unclaimed notes between syllable claims get `-` continuation markers in a second pass. Result: every syllable gets exactly one note, no syllables skipped, no overwrites.

### Anchor note x-positions to syllable range, not glyph range
First attempt estimated each OMR note's PDF-space x by proportionally mapping its index across the staff line's music-font glyph x-positions. This breaks when glyph detection misses leading noteheads (clefs/key sigs not always in the MUSIC_FONT_RE charset). Better: anchor noteXs to `[sylMin, sylMax]` of the syllable row. Engravers position syllables under their notes by design, so the syllable layout IS the notehead layout. Robust to MUSIC_FONT_RE coverage gaps.

### Lyrics-only rows are not optional
Many lead-sheet PDFs only print chord changes on the first line of each phrase — subsequent staff lines reuse the previous chord, so the engraver doesn't reprint it. The chord-chart extractor classifies those lyric rows as `lyrics-only` (no chord row above). Skipping them loses ~half the song's lyrics in Choosin' Texas. Fix: process both `pair` and `lyrics-only` entries in `assignLyricsFromChordPairs`. Filter watermarks ("Authorized for use by…") by y-position (< 50pt) and content regex.

### Hyphenated continuation across staff lines
When a word splits across two staff lines (e.g. "T en - nes -" at end of one line + "see," at start of next), the trailing `-` is a deliberate engraver signal: this word continues on the next line. The PDF lyric row contains the standalone `-` token between the syllable fragments. To preserve this across system boundaries, syllables that overflow a system's notes are stored as `carryover` and prepended (unconditionally, no x check) to the next system's note claims. Without carryover, the algorithm drops the tail of each line and the word reconstruction fails ("Tennessee" → "T en").

### systemBreaks need extrapolation past the last detected break
Audiveris reports system breaks (measure numbers where new staff lines begin) only as far as the OMR detected. If the PDF has visual repeats (D.S. al Fine, repeated chorus blocks) that Audiveris collapsed into a single pass through the notes, the PDF has MORE lyric rows than there are Audiveris systems. Extrapolating the breaks list by `avgGap` past `maxMeasure` lets trailing lyric rows still get a startMeasure assignment. Those final rows often have 0 notes (because Audiveris truly didn't expand the repeat) — accept the loss until backend MusicXML repeat expansion is implemented.

### Don't trust PDF text-extraction `hasTrailingSpace` for word boundaries
First attempt at merging PDF text fragments (turning `"lone", "nes", "ome"` back into `"lonesome"`) used `hasTrailingSpace` as the word-boundary signal. Fails on PDFs that don't preserve spaces between visible words — merge then glued real word boundaries together (`"Justwhen"`, `"Ishould"`, `"Andjudg"`). Without a reliable signal, leave fragments alone and rely on the singer to infer in context. Single-letter consonant filters also hurt more than help (drop "Y" from "Yeah", "T" from "Tex-as"). Net-best policy: keep all non-numeric tokens, trust the visual layout.

### Test harness in Node (`test_walk_forward.mjs`)
For algorithm iteration without browser reloads, the full chord-extraction + lyric-assignment pipeline runs standalone in Node using `pdfjs-dist/legacy/build/pdf.js`. Reads cached OMR notes from `songs_cache/*.json`, extracts text items from the PDF, and prints per-system assignments. Use this to iterate on the algorithm; verify against `App.jsx` after each change. Test against `Choosin' Texas` — known good when the first sung note (m.6 Db5) shows `"Just"` and the line-1/line-2 seam spells `"Ten-nes-see"`.

### Diagnostic: instrument first, don't guess
For threshold-setting or "what's the actual x of X" questions, add a one-line `dbg()` (frontend) or `console.log` (test harness) that prints the value. Eyeballing screenshots or estimating from defaults is unreliable and wastes turns. The `walkForward.system0` dump (glyphXs, sortedSyllables, noteXs side-by-side) revealed the "T-en before the first notehead" issue that the nearest-syllable rule was creating — a screenshot couldn't have shown that.
