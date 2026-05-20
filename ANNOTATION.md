# Personal Singing Annotation System

## Chart Layout
- Every lyric line begins with the chord that is active at the start of that line
- Chord names are horizontally positioned above the exact syllable where they land
- This means you always know your chord at a glance — no scanning back up the page

## Melody Direction
- `/` — big upward jump on this syllable (minor 3rd or more)
- `\` — big downward jump on this syllable (minor 3rd or more)
- Only marked on significant changes — small steps are left unmarked
- `/\` — rises then falls on the same syllable
- `\/` — falls then rises

## Melismas
- Hyphens inside a word mark one syllable stretched across multiple notes
- Direction markers inside the hyphenated word show movement during the stretch
- Example: `wa-\ay` = "way" is a melisma, melody falls across it
- Example: `u-\u-us` = "us" stretched across notes, falling
- Example: `gli--mpse` = double hyphen = longer melisma

## Beat Markers
- Numbers (2, 3, 4) = the beat within the measure that the next event lands on
- Beat 1 is implied by the chord name itself
- Example: `Fm    2` = Fm on beat 1, next event on beat 2
- Can be 2, 3, or 4 in simple meters (4/4, 3/4, 2/4)

### Compound meters (6/8, 9/8, 12/8)
6/8 is **compound duple** — 6 eighth notes per measure but only **2 felt beats** (each a dotted quarter). Singers don't count "1 2 3 4 5 6" because that loses the rolling pulse. Common counting systems:

| System | Looks like | Notes |
|---|---|---|
| Compound-2 with subdivisions | `1 & a   2 & a` | Default for singing. Preserves the 2-pulse feel. |
| Gordon syllables | `1 la li   2 la li` | Choral / Kodály training. |
| Straight-six | `1 2 3 4 5 6` | Only at slow tempos when every eighth genuinely matters. |

**App convention for compound meters:**
- Only digit beat-markers are `2` (the second dotted-quarter pulse)
- Sub-beat positions use `&` (second eighth of a beat) or `a` (third eighth)
- Example for 6/8: `She'd take the &world a off my shoul 2ders`
  - `She'd` on beat 1, `world` on the `&` of 1, `off` on the `a` of 1, `shoul` on beat 2
- 9/8 = compound triple: beats `2`, `3`; 12/8 = compound quadruple: beats `2`, `3`, `4`

The OMR beat-marker generator needs the time signature to choose between simple-meter digits and compound-meter `& a` syllables.

## Emphasis
- `*asterisks*` around a phrase = melodically tricky, requires attention
- Applied to phrases with unusual subdivisions or mid-word direction changes
- Example: `*Do I still*`, `*the /wa-\ay it /w\a\as*`

## Chord Substitutions
- `or Cm/G` = either chord works here
- Slash chords like `Eb6/G` or `Cm7/G` = specific bass note voicing

## Example
```
Fm             2                 Fm    2
She'd take the world off my shou lders   If it was
Bbm7         2     Bbm7
ever hard to move-
```

## Extraction Rules (how the app finds chords/lyrics in a PDF)

The PDF text layer is grouped into rows by y-coordinate. Notation rows are detected by the music engraving font characters (Ï, Î, etc.) and used as anchors:

- **Title pages** (any PDF page with no notation rows) are dropped entirely. This kills copyright text, author lists, "Authorized for use by", and the song title splash.
- **Proximity filter**: a text row is only considered if it is within **80pt** of a notation row on the same page. This drops per-page headers like `CHOOSIN' TEXAS p. 2 of 4` and `2 copies licensed`.
- **Notation rows themselves are skipped** (they're the staff, not text).
- **Section detection** requires a short row (≤ 4 word-tokens) whose first non-number token is a known section keyword (verse, chorus, bridge, coda, etc.). This avoids false positives like `Bridge 1 Music` inside copyright text.
- **Chord row** = has a measure number OR ≥ 2 chord tokens, AND at least one chord is multi-character (e.g. `Eb`, `Bbm`, `Eb7`). Single-letter-only rows like `E m G D` are filtered out — those are key-signature labels from the staff, not chord names.
- **Lyric row** = has at least one word-token that isn't a chord or number.
- **NOISE filter** drops rows containing copyright/license/publisher text, page headers (`p. 2 of 4`), tempo markings (`Moderately`, `Allegro`, `rit.`), and navigation markers (`D.S. al`, `D.C. al`).
- **Pairing**: chord row above lyric row within 300pt on the same page.
