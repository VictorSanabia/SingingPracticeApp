import React, { useState, useRef, useEffect, useCallback } from 'react';
import * as pdfjs from 'pdfjs-dist';
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';

pdfjs.GlobalWorkerOptions.workerSrc =
  `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`;

// ── Music utilities ──────────────────────────────────────────────────
const CHROMATIC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FLAT_NAMES = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
// Pitch classes whose conventional key signature uses flats
const FLAT_MAJOR_ROOTS = new Set([5, 10, 3, 8, 1, 6]); // F, Bb, Eb, Ab, Db, Gb
const FLAT_MINOR_ROOTS = new Set([2, 7, 0, 5, 10, 3]); // D, G, C, F, Bb, Eb
function usesFlats(root, mode) {
  return (mode === 'major' ? FLAT_MAJOR_ROOTS : FLAT_MINOR_ROOTS).has(root);
}
function pcName(pc, useFlats) {
  return (useFlats ? FLAT_NAMES : CHROMATIC)[pc];
}
const FLAT_TO_SHARP = { Db:'C#', Eb:'D#', Fb:'E', Gb:'F#', Ab:'G#', Bb:'A#', Cb:'B' };

function noteToMidi(name) {
  const m = name.trim().match(/^([A-G][#b]?)(\d)$/);
  if (!m) return null;
  let [, n, o] = m;
  if (FLAT_TO_SHARP[n]) n = FLAT_TO_SHARP[n];
  const idx = CHROMATIC.indexOf(n);
  if (idx < 0) return null;
  return (parseInt(o) + 1) * 12 + idx;
}
function midiToFreq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }
function noteToFreq(name) { const m = noteToMidi(name); return m != null ? midiToFreq(m) : null; }
function freqToMidi(f) { return 69 + 12 * Math.log2(f / 440); }
function freqToName(f) {
  const midi = Math.round(freqToMidi(f));
  return CHROMATIC[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}
function centsDiff(targetFreq, sungFreq) { return 1200 * Math.log2(sungFreq / targetFreq); }
function shiftNote(name, semitones) {
  if (!semitones) return name;
  const midi = noteToMidi(name);
  if (midi == null) return name;
  const shifted = midi + semitones;
  const idx = ((shifted % 12) + 12) % 12;
  const oct = Math.floor(shifted / 12) - 1;
  // Preserve the input's accidental convention. If the OMR named the note
  // with a flat (Eb, Bb, Ab…), shifted black-key notes also use flats so a
  // flat-key song stays consistent across octaves. Otherwise default sharps.
  const useFlats = /^[A-G]b/.test(name.trim());
  return (useFlats ? FLAT_NAMES : CHROMATIC)[idx] + oct;
}

function centsToStatus(c) {
  const a = Math.abs(c);
  if (a <= 50) return 'green';
  if (a <= 100) return 'yellow';
  return 'red';
}

// ── Pitch detection (autocorrelation) ───────────────────────────────
function detectPitch(buf, sampleRate) {
  // Silence gate
  let rms = 0;
  for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
  if (Math.sqrt(rms / buf.length) < 0.075) return null;

  // YIN algorithm — better harmonic rejection than autocorrelation
  const N = buf.length;
  const half = Math.floor(N / 2);
  const yin = new Float32Array(half);
  yin[0] = 1;
  let runningSum = 0;

  for (let tau = 1; tau < half; tau++) {
    let diff = 0;
    for (let j = 0; j < half; j++) {
      const delta = buf[j] - buf[j + tau];
      diff += delta * delta;
    }
    runningSum += diff;
    yin[tau] = runningSum === 0 ? 0 : (diff * tau) / runningSum;
  }

  // Find first dip below threshold (0.12 = good balance sensitivity/accuracy)
  const THRESHOLD = 0.12;
  let tau = 2;
  while (tau < half - 1) {
    if (yin[tau] < THRESHOLD) {
      while (tau + 1 < half - 1 && yin[tau + 1] < yin[tau]) tau++;
      break;
    }
    tau++;
  }
  if (tau >= half - 1 || yin[tau] >= THRESHOLD) return null;

  // Parabolic interpolation for sub-sample accuracy
  const prev = yin[tau - 1], curr = yin[tau], next = yin[tau + 1];
  const denom = 2 * curr - prev - next;
  const refined = tau + (denom ? (prev - next) / (2 * denom) : 0);

  const freq = sampleRate / refined;
  return freq >= 60 && freq <= 1200 ? freq : null;
}

// Plausible song tempo range — used to filter stray tempo numerals out of chord
// rows and to bound the BPM input field. Single source of truth.
const BPM_MIN = 40;
const BPM_MAX = 300;

// Claim-then-fill lyric mapping: chord chart is the single source of truth.
// Two-pass algorithm matching how a singer reads a lead sheet:
//   Pass 1 — each syllable claims the first unclaimed note whose estimated x
//            is ≥ the syllable's x. Cursor advances monotonically so syllables
//            map left-to-right with no skipping.
//   Pass 2 — notes with no claimant inherit the previous syllable as a "-"
//            continuation (melisma extension).
//
// Note x-positions are estimated by mapping each note's system-index onto the
// syllable x-range (not the glyph x-range — glyph detection misses leading
// noteheads in many PDFs, which skews proportional mapping). The syllable
// layout reliably reflects the actual notehead layout because engravers
// position syllables under their notes.
//
// System span comes from Audiveris's systemBreaks anchored on the first pair
// with an explicit measure number printed in the PDF.
function assignLyricsFromChordPairs(notes, chordPairs, systemBreaks = []) {
  if (!notes.length || !chordPairs.length) return notes;

  // Include both 'pair' entries (chord row + lyric row) AND 'lyrics-only'
  // entries — many PDFs only print chord changes on the first line and reuse
  // the chord on subsequent staff lines, so lyric rows below those lines
  // don't get a chord row directly above. Without 'lyrics-only', we'd miss
  // ~half the song. Filter out page footers (y < 50pt = page-bottom
  // watermarks like "Authorized for use by: <name>").
  const WATERMARK_RE = /authoriz|all\s*rights|©|copyright/i;
  const lyricBearing = chordPairs
    .filter(p => p.type === 'pair' || p.type === 'lyrics-only')
    .map(p => {
      const row = p.type === 'pair' ? p.lyricRow : p.row;
      return { type: p.type, row, staffGlyphXs: p.staffGlyphXs || [], chordRow: p.chordRow };
    })
    .filter(e => {
      if (!e.row || e.row.y < 50) return false;
      const text = (e.row.rawItems || []).map(i => i.s).join(' ');
      return !WATERMARK_RE.test(text);
    });

  if (!lyricBearing.length) {
    dbg('assignLyricsFromChordPairs', { reason: 'no lyric-bearing entries — leaving lyrics untouched' });
    return notes;
  }

  // Order by PDF reading order (page asc, y desc — larger y = top of page).
  lyricBearing.sort((a, b) => a.row.page - b.row.page || b.row.y - a.row.y);

  // Parse explicit measure number per entry (from chord row when present).
  const explicit = lyricBearing.map(e => {
    if (e.type !== 'pair') return null;
    const tokens = (e.chordRow.merged || []).map(i => i.s);
    const m = tokens.find(t => /^\d+$/.test(t));
    return m != null ? +m : null;
  });
  // Keep `pairs` as alias for the loop below — minimal blast radius.
  const pairs = lyricBearing;

  // Audiveris's systemBreaks list the measure numbers where new staff lines
  // begin in the engraved score. PDF reading order matches OMR order, so
  // pair[i] ↔ breaks[i + offset]. Anchor offset on the first explicit pair
  // by finding the system whose range [breaks[j], breaks[j+1]) contains M.
  const breaks = Array.isArray(systemBreaks) ? [...systemBreaks].sort((a, b) => a - b) : [];
  // Extrapolate past the last break so lyric rows beyond Audiveris's last
  // detected system still get a startMeasure. Without this, the final 2-3
  // lyric lines (typically the outro / final chorus repeat) get dropped.
  const maxMeasure = notes.reduce((m, n) => Math.max(m, n.measure || 0), 0);
  if (breaks.length >= 2) {
    const avgGap = Math.max(1, Math.round((breaks[breaks.length - 1] - breaks[0]) / (breaks.length - 1)));
    while (breaks[breaks.length - 1] < maxMeasure + avgGap) {
      breaks.push(breaks[breaks.length - 1] + avgGap);
    }
  }
  let offset = 0;
  const firstExplicitIdx = explicit.findIndex(m => m != null);
  if (firstExplicitIdx >= 0 && breaks.length) {
    const M = explicit[firstExplicitIdx];
    let anchorJ = 0;
    for (let j = 0; j < breaks.length; j++) {
      const next = j + 1 < breaks.length ? breaks[j + 1] : Infinity;
      if (breaks[j] <= M && M < next) { anchorJ = j; break; }
      if (breaks[j] > M) { anchorJ = Math.max(0, j - 1); break; }
      anchorJ = j;
    }
    offset = anchorJ - firstExplicitIdx;
  }

  const systems = pairs.map((p, i) => {
    let startMeasure = explicit[i];
    let endMeasure = null;
    if (breaks.length) {
      // Prefer Audiveris's system-start measure over the printed number — they
      // can disagree when the PDF skips numbering on pickups or repeats.
      const j = i + offset;
      if (j >= 0 && j < breaks.length) startMeasure = breaks[j];
      // Bound the system by the NEXT Audiveris break. For the last pair this
      // prevents it from absorbing every trailing note (~77 notes vs 14 syllables).
      if (j + 1 < breaks.length) endMeasure = breaks[j + 1];
    }
    const sylItems = (p.row.rawItems || [])
      .map(it => ({ s: it.s.trim().replace(/\(.*?\)/g, '').trim(), x: it.x }))
      .filter(it => it.s && !/^\d+\.?$/.test(it.s));
    return {
      startMeasure,
      endMeasure,
      sylItems,
      glyphXs: p.staffGlyphXs || [],
      explicit: explicit[i],
      pairIdx: i,
    };
  }).filter(s => s.startMeasure != null);

  systems.sort((a, b) => a.startMeasure - b.startMeasure);

  if (!systems.length) {
    dbg('assignLyricsFromChordPairs', {
      reason: 'no pair had a determinable startMeasure',
      pairCount: pairs.length, breaksCount: breaks.length,
    });
    return notes;
  }

  const out = notes.map(n => ({ ...n, lyric: '' }));
  const sysDiag = [];
  // Carryover: syllables that didn't fit on the previous system's notes,
  // typically the tail of a hyphenated word (e.g. "T en - nes -" continuing
  // into the next line's "see" → spells "Tennessee" across the two lines).
  let carryover = [];

  for (let i = 0; i < systems.length; i++) {
    const { startMeasure, endMeasure, sylItems, glyphXs, explicit: exp, pairIdx } = systems[i];
    // Prefer the next Audiveris break (endMeasure) to bound the system, then
    // fall back to the next pair's startMeasure, then Infinity for the tail.
    const end = endMeasure
      ?? (i + 1 < systems.length ? systems[i + 1].startMeasure : Infinity);
    const noteIdxs = [];
    for (let j = 0; j < out.length; j++) {
      if (out[j].measure != null && out[j].measure >= startMeasure && out[j].measure < end) {
        noteIdxs.push(j);
      }
    }

    let mode;
    let assignments = 0;
    let continuations = 0;
    const sortedSyl = [...sylItems].sort((a, b) => a.x - b.x);
    const sN = sortedSyl.length;
    const nN = noteIdxs.length;
    const carriedIn = carryover.length;
    let carriedOut = 0;
    if ((sN > 0 || carryover.length > 0) && nN > 0) {
      mode = 'claim-then-fill';
      // Estimate each note's x by mapping its index proportionally into the
      // syllable x range. (Per-measure clustering was attempted to handle
      // bar-line x-gaps but it dropped content in songs with carryover
      // between systems — reverted to single-cluster index map.)
      const sylMin = sN > 0 ? sortedSyl[0].x : 0;
      const sylMax = sN > 0 ? sortedSyl[sN - 1].x : 0;
      const noteXs = noteIdxs.map((_, k) => {
        if (nN === 1 || sN <= 1) return sylMin;
        return sylMin + (k / (nN - 1)) * (sylMax - sylMin);
      });
      // owners[k] holds the syllable OBJECT (not index) so carryover from a
      // different system can be stored alongside this system's syllables.
      const owners = new Array(nN).fill(null);
      let cursor = 0;
      const nextCarryover = [];

      // Phase 1 — drain carryover into leading notes unconditionally. The x
      // of carryover syllables is from a prior system and not meaningful here.
      let ci = 0;
      while (ci < carryover.length && cursor < nN) {
        owners[cursor++] = carryover[ci++];
      }
      while (ci < carryover.length) nextCarryover.push(carryover[ci++]);

      // Phase 2 — claim by NEAREST note from cursor (not first note where
      // nx ≥ sx). Short words like "in" sit at their left-edge x but the
      // notehead is a few pt to the right — first-note-after-x undershoots
      // and gives that note to the previous syllable as a hold instead.
      // Cursor still advances monotonically so syllable order is preserved.
      let s = 0;
      for (; s < sN; s++) {
        const sx = sortedSyl[s].x;
        let bestK = -1;
        let bestD = Infinity;
        for (let k = cursor; k < nN; k++) {
          const d = Math.abs(noteXs[k] - sx);
          if (d < bestD) { bestD = d; bestK = k; }
          else if (bestK >= 0) break;  // noteXs monotonic; distance climbing
        }
        if (bestK < 0) break;
        owners[bestK] = sortedSyl[s];
        cursor = bestK + 1;
      }
      for (let r = s; r < sN; r++) nextCarryover.push(sortedSyl[r]);

      // Render. Unclaimed notes inherit the previous syllable as "-".
      let lastSyl = null;
      for (let k = 0; k < nN; k++) {
        let syl = owners[k];
        let isCont = false;
        if (!syl) {
          if (!lastSyl) continue;  // before first syllable — leave blank
          syl = lastSyl;
          isCont = true;
        }
        const text = isCont ? '-' : syl.s;
        out[noteIdxs[k]] = { ...out[noteIdxs[k]], lyric: text };
        assignments++;
        if (isCont) continuations++;
        if (!isCont) lastSyl = syl;
      }

      carriedOut = nextCarryover.length;
      carryover = nextCarryover;
    }

    sysDiag.push({
      pairIdx,
      startMeasure,
      explicit: exp ?? null,
      mode,
      sylCount: sylItems.length,
      glyphCount: glyphXs.length,
      noteCount: noteIdxs.length,
      assigned: assignments,
      continuations,
      carriedIn,
      carriedOut,
      sample: sylItems.slice(0, 6).map(s => s.s),
    });
  }

  const assigned = out.filter(n => n.lyric).length;
  dbg('assignLyricsFromChordPairs', {
    pairCount: pairs.length,
    systemCount: systems.length,
    breaksCount: breaks.length,
    breakOffset: offset,
    systems: sysDiag,
    totalNotes: out.length,
    notesWithLyrics: assigned,
    firstNotesAfter: out.slice(0, 20).map(n => ({ measure: n.measure, note: n.note, lyric: n.lyric })),
  });
  return out;
}

// ── Backend debug log (writes to server-side debug.log so Claude can read it) ──
// Active only in Vite dev mode — no-op in production builds.
function dbg(tag, data) {
  if (!import.meta.env.DEV) return;
  try {
    fetch('http://localhost:5001/debug-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag, data }),
    }).catch(() => {});
  } catch {}
}

// ── Shared PDF-text helpers (used by both extractors) ────────────────
// Music-engraving font glyphs (Finale, Sibelius, etc.). Identifying these on
// a row means the row is part of the staff / notation, not text content.
const MUSIC_FONT_RE = /[ÏÎïîúùÈèÀáÂâÄäÀ-ÅÈ-ÏÒ-ÖÙ-Ýà-åè-ïò-öù-ý]/;

// Non-content rows we never want to surface as lyrics or chord rows. Combines
// the union of patterns previously duplicated across the two extractors:
// copyright/legal/publisher boilerplate, tempo + dynamic markings, performance
// directions, navigation tokens (D.S., D.C., to coda), page headers, and
// instrumental cues. Single source of truth.
const NON_CONTENT_RE = /copyright|©|\(c\)|all\s*right|reserved|international|unauthorized|reproduction|prohibited|transmission|duplication|hal.?leonard|warner|sony|kobalt|alfred|music sales|cherry lane|publish|copies licensed|p\.\s*\d+\s*of\s*\d+|transcribed|arranged\s*by|engraved|licensed|digital|sheet\s*music|words\s*(and|&)\s*music|music\s*by|lyrics\s*by|words\s*by|from\s*the\s*(musical|movie|film|album)|moderately|slowly|quickly|brightly|allegro|andante|adagio|\brit\.|d\.s\.?\s*al|d\.c\.?\s*al|to\s*coda|\(instr|\(spoken|additional\s*lyric|additonal|see\s+additional|^\s*\(\d+\.\)|\bgently\b|\bwith\s*(feeling|a\s+lilt|spirit|swing|energy)\b|performance\s*note|play\s*\d|=\s*\d+(\s*[-–]\s*\d+)?|^\s*coda\s+[ivx]+\s*$|^\s*=?\s*\d{2,3}\s*[-–]\s*\d{2,3}\s*$|\bpedal\b|\bcont\.?\s*sim\.?|\b8va\b|2°|¡/i;

// Section labels: "Verse", "Chorus", "Bridge", etc. (optionally followed by a
// number). Navigation markers, never chord or lyric content.
const SECTION_LABEL_RE = /^(verse|chorus|bridge|intro|outro|pre.?chorus|hook|tag|interlude|refrain|coda|vamp|solo|breakdown|ending)(\s*\d+)?$/i;

// Default vertical distance (pt) between body text and the nearest staff.
const STAFF_PROXIMITY_PT = 80;

// Build a Map<page, ys[]> of staff y-positions, identified by rows that
// contain at least one music-font glyph.
// Group music-font glyphs into rows and only count rows with enough glyphs as
// staves. Chord-diagram blocks (e.g. Hozier's "From Eden") render their
// vertical strings as 2-3 Ï glyphs in the music font — without this filter
// those would be mistaken for staves, letting "x o o" muted/open indicator
// rows below them pass the lyric proximity check.
const MIN_GLYPHS_PER_STAFF = 5;
function collectStaffYs(items) {
  const rowCounts = new Map();
  for (const it of items) {
    if (!MUSIC_FONT_RE.test(it.s)) continue;
    const key = `${it.page}-${Math.round(it.y / 5)}`;
    const r = rowCounts.get(key);
    if (r) r.count++;
    else rowCounts.set(key, { page: it.page, y: it.y, count: 1 });
  }
  const map = new Map();
  for (const r of rowCounts.values()) {
    if (r.count < MIN_GLYPHS_PER_STAFF) continue;
    if (!map.has(r.page)) map.set(r.page, []);
    map.get(r.page).push(r.y);
  }
  return map;
}

// Is (page, y) within `maxDist` of a staff on the same page?
//   side: 'below' = staffY must be above the text (real lyric rows sit below
//                   the staff in PDF coords, where larger y = higher up).
//         'either' = chords or lyrics; staff may be above or below.
// Returns false on pages with no staff (e.g., dedicated title pages).
function nearStaff(staffMap, page, y, { side = 'either', maxDist = STAFF_PROXIMITY_PT } = {}) {
  const ys = staffMap.get(page);
  if (!ys || !ys.length) return false;
  return ys.some(sy => {
    const diff = sy - y;
    if (side === 'below') return diff > 0 && diff <= maxDist;
    return Math.abs(diff) <= maxDist;
  });
}

// Non-content classifier — same checks shared between extractors.
// Returns the reason string if the row should be dropped, or null to keep.
function classifyNonContent(joined) {
  const trimmed = joined.trim();
  if (NON_CONTENT_RE.test(joined)) return 'noise';
  if (SECTION_LABEL_RE.test(trimmed)) return 'section';
  return null;
}

// ── PDF text extraction ──────────────────────────────────────────────
async function extractLyricsFromPdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const allItems = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const vp   = page.getViewport({ scale: 1 });
    const { items: raw } = await page.getTextContent();
    for (const it of raw) {
      const s = it.str.trim();
      if (!s) continue;
      const h = it.height > 0 ? it.height : Math.abs(it.transform[3]);
      allItems.push({ s, x: it.transform[4], y: it.transform[5], h,
                      page: p, pageH: vp.height, pageW: vp.width });
    }
  }

  // Median font size — lyrics are body-size text, titles are larger
  const heights = allItems.map(i => i.h).filter(h => h > 0).sort((a, b) => a - b);
  const medH = heights[Math.floor(heights.length / 2)] || 10;

  // Real lyrics sit just BELOW a staff (~17-24pt). Titles, credits, tempo, and
  // section labels sit above or far from any staff. Drop everything not below.
  const staffYs = collectStaffYs(allItems);

  const CHORD    = /^[A-G][#b]?(m|maj|min|dim|aug|sus\d?|add\d?|\/[A-G][#b]?|\d)*$/;
  const NOTE_PAT = /^[A-G][#b]?\d$/;
  const NON_LYRIC = /^(\d+\.?|pp|p|mp|mf|f|ff|fff|sfz|N\.C\.|D\.C\.|D\.S\.|Fine|rit\.?|ritard\.?|rall\.?|accel\.?|a\s*tempo|poco|molto|simile|tacet|cresc\.?|decresc\.?|dim\.?)$/i;

  // Pre-filter: remove things that definitely aren't lyric words
  const rejectStats = { font: 0, edge: 0, notBelowStaff: 0, noise: 0, section: 0, nonLyric: 0, note: 0, chord: 0, singleChar: 0, multiWord: 0, nonAlpha: 0 };
  const candidates = allItems.filter(it => {
    if (it.h > medH * 1.5) { rejectStats.font++; return false; }       // larger font = title/heading
    if (it.y < it.pageH * 0.05) { rejectStats.edge++; return false; }  // very bottom = copyright
    if (!nearStaff(staffYs, it.page, it.y, { side: 'below' })) { rejectStats.notBelowStaff++; return false; }
    const reason = classifyNonContent(it.s);
    if (reason === 'noise')   { rejectStats.noise++;   return false; }
    if (reason === 'section') { rejectStats.section++; return false; }
    if (NON_LYRIC.test(it.s)) { rejectStats.nonLyric++; return false; }
    if (NOTE_PAT.test(it.s))  { rejectStats.note++;    return false; }
    if (CHORD.test(it.s) && it.s.length <= 6) { rejectStats.chord++; return false; }
    if (it.s.length === 1 && !/^[IAa]$/.test(it.s)) { rejectStats.singleChar++; return false; }
    if (it.s.split(/\s+/).length > 3)   { rejectStats.multiWord++; return false; }
    if (!/[a-zA-Z]/.test(it.s))         { rejectStats.nonAlpha++;  return false; }
    return true;
  });
  const lyricExtractDiag = {
    totalItems: allItems.length, medH: +medH.toFixed(1),
    staffPages: [...staffYs.entries()].map(([p, ys]) => `p${p}:${ys.length}`).join(' ') || '(none)',
    rejects: rejectStats, candidates: candidates.length,
  };
  console.log('[lyricExtract] diag:', lyricExtractDiag);
  dbg('lyricExtract.diag', lyricExtractDiag);

  // ── Y-clustering: the key insight ────────────────────────────────────
  // Lyric lines = many words at the SAME y-position spread across the page.
  // Titles / dynamics / chord names = 1–3 items at a unique y-position.
  // We bucket items into horizontal rows and only keep rows that are
  // "wide and populous" enough to be a genuine lyric line.
  const YTOL = 3; // PDF units — items within 3pt of each other = same row
  const rows = new Map();
  for (const it of candidates) {
    const bucket = Math.round(it.y / YTOL);
    const key    = `${it.page}-${bucket}`;
    if (!rows.has(key)) rows.set(key, { page: it.page, pageW: it.pageW, items: [] });
    rows.get(key).items.push(it);
  }

  const lyricItems = [];
  for (const row of rows.values()) {
    if (row.items.length < 3) continue; // fewer than 3 items = almost certainly not lyrics

    const xs      = row.items.map(i => i.x);
    const xSpread = Math.max(...xs) - Math.min(...xs);
    const spreadRatio = xSpread / (row.pageW || 500);

    // Score: a dense lyric line scores high; a lone dynamic/chord scores low
    const score = row.items.length * spreadRatio;
    if (score >= 1.5) lyricItems.push(...row.items);
  }

  lyricItems.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  return lyricItems.map(it => it.s);
}

// ── Chord chart extraction from PDF ─────────────────────────────────
async function extractChordChartFromPdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;

  const CHORD_RE   = /^([A-G][#b]?(maj7?|min7?|m7?|dim7?|aug|sus[24]?|add\d?|\/[A-G][#b]?|\d+)*|N\.?C\.?)$/;
  // NOISE / SECTION_LABEL / MUSIC_FONT moved to module scope — see top of file.

  const allItems = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const { items } = await page.getTextContent();
    for (const it of items) {
      const raw = it.str;
      const s = raw.trim();
      if (!s) continue;
      // hasTrailingSpace: PDF kept a space after this token → it's a hard word boundary.
      const hasTrailingSpace = /\s$/.test(raw);
      const h = it.height > 0 ? it.height : Math.abs(it.transform[3]);
      allItems.push({ s, x: it.transform[4], y: it.transform[5], page: p, w: it.width || 0, h, hasTrailingSpace });
    }
  }

  // Median glyph height — anything substantially larger is a title/heading, not a chord/lyric.
  const heights = allItems.map(i => i.h).filter(h => h > 0).sort((a, b) => a - b);
  const medH = heights[Math.floor(heights.length / 2)] || 10;
  const BIG_FONT = medH * 1.5;

  // Group into rows by page + y (5pt tolerance)
  const rowMap = new Map();
  for (const it of allItems) {
    const key = `${it.page}-${Math.round(it.y / 5)}`;
    if (!rowMap.has(key)) rowMap.set(key, { page: it.page, y: it.y, rawItems: [] });
    rowMap.get(key).rawItems.push(it);
  }

  // Collect staff y-positions from music-font glyph rows.
  const notationYs = collectStaffYs(allItems);

  // Collect per-staff-line glyph x-positions. Each music-font row IS a staff line;
  // its glyphs sit at the x-coordinates where note heads appear in the rendered PDF.
  // We use these to spatially anchor lyrics under the notes they belong to.
  // We capture every short token (≤ 3 chars) on a music-font row, not just the
  // chars that match MUSIC_FONT_RE — many noteheads render as ASCII glyphs from
  // the music font, so a strict regex match undercounts notes. Dedupe tightens
  // to 4pt so we don't collapse adjacent eighth-notes into a single position.
  const staffLines = []; // { page, y, glyphXs: sorted unique array of x-coords }
  for (const row of rowMap.values()) {
    if (!row.rawItems.some(i => MUSIC_FONT_RE.test(i.s))) continue;
    const xs = row.rawItems
      .filter(i => i.s.length <= 3 && !/\s/.test(i.s))
      .map(i => i.x)
      .sort((a, b) => a - b);
    const glyphXs = [];
    for (const x of xs) {
      if (!glyphXs.length || x - glyphXs[glyphXs.length - 1] > 4) glyphXs.push(x);
    }
    // Filter out chord-diagram "fake staves" — see MIN_GLYPHS_PER_STAFF above.
    if (glyphXs.length < MIN_GLYPHS_PER_STAFF) continue;
    staffLines.push({ page: row.page, y: row.y, glyphXs });
  }
  // Find the staff line on a given page whose y sits between two PDF rows
  // (chord row above, lyric row below). In PDF coords larger y = higher up,
  // so chordY > staffY > lyricY.
  function staffBetween(page, chordY, lyricY) {
    let best = null, bestDist = Infinity;
    const target = (chordY + lyricY) / 2;
    for (const sl of staffLines) {
      if (sl.page !== page) continue;
      if (sl.y < chordY && sl.y > lyricY) {
        const d = Math.abs(sl.y - target);
        if (d < bestDist) { bestDist = d; best = sl; }
      }
    }
    return best;
  }

  // Merge "B" + "b" + "m7" → "Bbm7", "E" + "7" → "E7", "A" + "b" + "maj7" → "Abmaj7", etc.
  // Pulls beat-marker digits (2/3/4) aside so they don't break absorption between root + suffix,
  // then re-merges them positionally. Allowed extension digits inside a chord: 5/6/7/9/11/13.
  function mergeFlats(items) {
    const sortedAll = [...items].sort((a, b) => a.x - b.x);
    const beatMarkers = sortedAll.filter(i => /^[234]$/.test(i.s));
    const s = sortedAll.filter(i => !/^[234]$/.test(i.s));
    // Allow concatenated suffix pieces: "m7add4" = m+7+add4, "6/G" = 6+/G, "7sus4" = 7+sus4
    const SUFFIX_PIECE = '(?:maj|min|dim|aug|sus|add|m|\\/[A-G][#b]?|\\d{1,2})';
    const SUFFIX_RE = new RegExp(`^${SUFFIX_PIECE}+$`, 'i');
    const GAP_ACCIDENTAL = 70;
    const GAP_SUFFIX     = 90;
    const out = [];
    let i = 0;
    while (i < s.length) {
      let str = s[i].s;
      let lastX = s[i].x;
      let j = i + 1;
      if (/^[A-G]$/.test(s[i].s)) {
        if (j < s.length && /^[b#]$/.test(s[j].s) && s[j].x - lastX < GAP_ACCIDENTAL) {
          str += s[j].s; lastX = s[j].x; j++;
        }
        while (j < s.length && SUFFIX_RE.test(s[j].s) && s[j].x - lastX < GAP_SUFFIX) {
          str += s[j].s; lastX = s[j].x; j++;
        }
      }
      out.push({ ...s[i], s: str });
      i = j;
    }
    // Splice beat markers back in by x-position.
    return [...out, ...beatMarkers].sort((a, b) => a.x - b.x);
  }

  // Some engraving programs emit lyric phrases as single text items with
  // internal spaces ("She'd take"@95, "er hard to move."@408). Split such
  // items into per-word sub-items, distributing x by char offset using
  // the item's width.
  function splitMultiWord(items) {
    const out = [];
    for (const it of items) {
      if (!/\s/.test(it.s)) { out.push(it); continue; }
      const text = it.s;
      const total = text.length;
      const w = it.w || total * 5;
      const re = /\S+/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        out.push({ ...it, s: m[0], x: it.x + (m.index / total) * w });
      }
    }
    return out;
  }

  const rejects = { music: 0, farFromNotation: 0, noise: 0, credits: 0, title: 0, section: 0, otherType: 0 };
  const sampleSurvivors = [];
  const rowDebug = [];
  const rows = [];
  for (const row of rowMap.values()) {
    row.rawItems.sort((a, b) => a.x - b.x);
    if (row.rawItems.some(i => MUSIC_FONT_RE.test(i.s))) { rejects.music++; continue; }
    if (!nearStaff(notationYs, row.page, row.y)) { rejects.farFromNotation++; continue; }
    // After proximity passes, record this row's distance to nearest staff for debugging.
    const ys = notationYs.get(row.page) || [];
    const nearestStaffY = ys.reduce((best, ny) => Math.abs(ny - row.y) < Math.abs(best - row.y) ? ny : best, ys[0]);
    const distToStaff = nearestStaffY != null ? Math.round(row.y - nearestStaffY) : null;
    const maxH = Math.max(...row.rawItems.map(i => i.h || 0));
    const preview = row.rawItems.map(i => i.s).join(' ').slice(0, 60);
    // Title / heading: every non-trivial token is in a noticeably larger font than the body.
    // Body text in charts averages ~10pt; titles run 16-30pt.
    const bigItems = row.rawItems.filter(i => i.h >= BIG_FONT);
    if (bigItems.length && bigItems.length === row.rawItems.length) { rejects.title++; continue; }
    const joined = row.rawItems.map(i => i.s).join(' ');
    const ncReason = classifyNonContent(joined);
    if (ncReason === 'noise')   { rejects.noise++;   continue; }
    if (ncReason === 'section') { rejects.section++; continue; }

    // Guitar chord-shape diagrams render their muted/open string indicators as
    // a row of "x" and "o" single-char tokens ("x o o x x o..."). They look
    // like a lyric row (text, below a staff) but contain no real words. Drop.
    // Expand multi-word tokens first ("x x" → ["x","x"]) since some PDFs emit
    // the indicator pairs as single text items.
    const expanded = row.rawItems
      .flatMap(i => i.s.split(/\s+/))
      .map(s => s.trim())
      .filter(s => s);
    const xoCount = expanded.filter(s => /^[xo]$/i.test(s)).length;
    const realWordCount = expanded.filter(s => /^[a-z]{2,}/i.test(s)).length;
    if (xoCount >= 5 && realWordCount <= 1) {
      rejects.noise++;
      continue;
    }
    // Drop "ALEXIS KESSELMAN, GEORGE MILLER and JOEL CASTILLO" style credit rows.
    // Operate on the joined string — PDFs sometimes return whole credit lines as one token.
    const alphaRuns = joined.match(/[A-Za-z]{2,}/g) || [];
    const upperRuns = alphaRuns.filter(s => /^[A-Z]{3,}$/.test(s));
    if (alphaRuns.length >= 2 && upperRuns.length >= Math.ceil(alphaRuns.length * 0.5)) { rejects.credits++; continue; }

    // Strip "Coda", "I"/"II"/"III"/"IV", lone "mp"/"p"/"f"/"mf" dynamics, and stray tempo numerals
    // BEFORE merging — these floating tokens otherwise contaminate chord rows.
    const cleanedItems = row.rawItems.filter(it => {
      const s = it.s;
      if (/^coda$/i.test(s)) return false;
      if (/^[IVX]{1,4}$/i.test(s) && s.length <= 4 && s !== 'I7' && s !== 'IV7') return false;
      if (/^(mp|mf|pp|ff|p|f)$/.test(s)) return false;
      if (/^=$/.test(s)) return false;
      if (/^\d{2,3}$/.test(s) && +s >= BPM_MIN && +s <= BPM_MAX) return false; // BPM numerals
      return true;
    });
    const merged     = mergeFlats(cleanedItems);
    const tokens     = merged.map(i => i.s);
    const chordItems = merged.filter(i => CHORD_RE.test(i.s));
    const hasMeasure = tokens.some(t => /^\d+$/.test(t) && +t < 500);
    const hasWords   = tokens.some(t => t.length >= 2 && /[a-z]/i.test(t) && !CHORD_RE.test(t) && !/^\d+$/.test(t));
    // Real chord rows have at least one multi-char chord (Eb, Bbm, Eb7…). Single-letter-only
    // rows like "E m G D" are key-signature labels from the staff, not chords.
    const hasRealChord = chordItems.some(i => i.s.length >= 2);

    // Lyrics always sit BELOW the nearest staff (negative distance, ~-17 to -24pt).
    // Anything above the staff with words is a section label, tempo marking, or chord row contaminated by text.
    const isBelowStaff = distToStaff != null && distToStaff < 0;

    let type = 'other';
    if      ((hasMeasure || chordItems.length >= 2) && hasRealChord && !hasWords)  type = 'chords';
    else if (hasWords && isBelowStaff)                                             type = 'lyrics';

    if (type !== 'other') {
      const finalItems = type === 'lyrics' ? splitMultiWord(row.rawItems) : row.rawItems;
      rows.push({ page: row.page, y: row.y, type, rawItems: finalItems, merged, chordItems });
    } else {
      rejects.otherType++;
      if (sampleSurvivors.length < 8) sampleSurvivors.push({ page: row.page, y: Math.round(row.y), tokens: tokens.slice(0, 12) });
    }
    rowDebug.push({
      page: row.page,
      y: Math.round(row.y),
      staffY: nearestStaffY != null ? Math.round(nearestStaffY) : null,
      dist: distToStaff,
      maxH: +maxH.toFixed(1),
      medH: +medH.toFixed(1),
      type,
      text: preview,
    });
  }

  rows.sort((a, b) => a.page - b.page || b.y - a.y);

  // Multi-stanza dedup: lead sheets sometimes stack verse 1 / verse 2 /
  // refrain-tag lyric rows directly under one staff (typically 8-12pt apart).
  // For each lyric row, find the nearest staff above it on the same page;
  // if any other lyric row sits between that row and the staff, this row is
  // a secondary stanza and gets dropped. Verse 1 (closest to the staff, the
  // topmost = largest y) survives.
  const lyricRows = rows.filter(r => r.type === 'lyrics');
  const dropLyric = new Set();
  for (const L of lyricRows) {
    const staffAbove = staffLines
      .filter(s => s.page === L.page && s.y > L.y)
      .reduce((a, b) => !a || b.y < a.y ? b : a, null);
    if (!staffAbove) continue;
    for (const M of lyricRows) {
      if (M === L) continue;
      if (M.page === L.page && M.y > L.y && M.y < staffAbove.y) {
        dropLyric.add(L);
        break;
      }
    }
  }
  if (dropLyric.size) {
    console.log(`[chordChart] dropped ${dropLyric.size} secondary-stanza lyric rows`);
    for (let i = rows.length - 1; i >= 0; i--) {
      if (dropLyric.has(rows[i])) rows.splice(i, 1);
    }
  }

  const chordDiag = {
    rawItems: allItems.length, rowsTotal: rowMap.size,
    notationPages: [...notationYs.entries()].map(([p, ys]) => `p${p}:${ys.length}`).join(' ') || '(none)',
    rejects, kept: rows.length,
    sampleOther: sampleSurvivors,
  };
  console.log('[chordChart] diag:', chordDiag);
  dbg('chordChart.diag', chordDiag);
  dbg('chordChart.rowDebug', rowDebug);
  console.log('[chordChart] rows:', rows.slice(0, 20).map(r => `${r.type}|"${r.merged.map(i => i.s).join(' ')}"`));
  // Per-row debug: every row that passed the proximity check, with distance to nearest staff,
  // its max font height, and how it was classified. Use this to spot the title row's distance.
  console.log('[chordChart] rowDebug:', rowDebug);
  console.table(rowDebug);

  const result = [];
  let pendingChord = null;
  for (const row of rows) {
    if (row.type === 'chords') {
      if (pendingChord) result.push({ type: 'chords-only', row: pendingChord });
      pendingChord = row;
    } else if (row.type === 'lyrics') {
      if (pendingChord && pendingChord.page === row.page && pendingChord.y - row.y < 300) {
        const sl = staffBetween(row.page, pendingChord.y, row.y);
        result.push({
          type: 'pair',
          chordRow: pendingChord,
          lyricRow: row,
          staffGlyphXs: sl ? sl.glyphXs : [],
        });
      } else {
        result.push({ type: 'lyrics-only', row });
      }
      pendingChord = null;
    }
  }
  console.log('[chordChart] result types:', result.map(r => r.type).join(', '));
  result.hasText = allItems.length > 0;
  return result;
}

function buildChordChartText(pairs, notes = []) {
  if (!pairs || !pairs.length) return '';
  const NCOLS = 130;
  // Bar-aligned layout: each chord is treated as the start of a new bar (true for this song).
  // Lyric x-coords are interpolated against chord x-coords to get a beat fraction within their bar,
  // and rendered at uniform per-bar width so beat 1 of each bar lines up vertically with its chord.
  const BAR_WIDTH = 18;
  const COLS_PER_BEAT = BAR_WIDTH / 4;

  // Per-note direction markers: big jump (≥4 semitones) or direction reversal (≥4 semitones).
  const noteDirs = notes.map((n, i) => {
    if (i === 0) return '';
    const pm = noteToMidi(notes[i - 1].note), cm = noteToMidi(n.note);
    if (!pm || !cm) return '';
    const diff = cm - pm;
    if (Math.abs(diff) >= 4) return diff > 0 ? '/' : '\\';
    if (i >= 2) {
      const pp = noteToMidi(notes[i - 2].note);
      if (pp) {
        const prev = pm - pp, cur = cm - pm;
        if (Math.abs(cur) >= 4 && (prev > 0) !== (cur > 0)) return cur > 0 ? '/' : '\\';
      }
    }
    return '';
  });

  const lyricSeq = notes
    .map((n, i) => ({
      lyric: (n.lyric || '').toLowerCase().replace(/[^a-z]/g, ''),
      dir: noteDirs[i],
      beat: n.beat,
      measure: n.measure,
    }))
    .filter(d => d.lyric);
  let cursor = 0;
  const seenBeatInMeasure = new Set();

  function lookupNote(text) {
    const norm = text.toLowerCase().replace(/[^a-z]/g, '');
    if (!norm || norm.length < 2) return null;
    const prefix = norm.slice(0, 3);
    for (let i = cursor; i < Math.min(cursor + 12, lyricSeq.length); i++) {
      if (lyricSeq[i].lyric.startsWith(prefix)) {
        cursor = i + 1;
        return lyricSeq[i];
      }
    }
    return null;
  }

  const toPositioned = (items, refItems) => {
    const allX = [...items.map(i => i.x), ...(refItems || []).map(i => i.x)];
    if (!allX.length) return '';
    const minX  = Math.min(...allX);
    const span  = Math.max(Math.max(...allX) - minX, 1);
    const arr   = Array(NCOLS + 40).fill(' ');
    const sorted = [...items].sort((a, b) => a.x - b.x);
    let nextFreeCol = 0;
    let prevHadTrailingSpace = false;
    for (const it of sorted) {
      let col = Math.min(arr.length - it.s.length, Math.max(0, Math.round(((it.x - minX) / span) * NCOLS)));
      const minGap = prevHadTrailingSpace ? 2 : 1;
      if (col < nextFreeCol + (minGap - 1)) col = nextFreeCol + (minGap - 1);
      for (let j = 0; j < it.s.length && col + j < arr.length; j++) arr[col + j] = it.s[j];
      nextFreeCol = col + it.s.length + 1;
      prevHadTrailingSpace = !!it.hasTrailingSpace;
    }
    return arr.join('').trimEnd();
  };

  // Bar-aligned placement: chord x-coords define bar starts. Each item gets snapped to a
  // (barIdx, beatInBar) pair, then rendered at a uniform per-bar width so chords stack
  // perfectly above the first lyric of each bar.
  function placeBarAligned(chordItems, lyricItems, beatItems = []) {
    const chords = [...chordItems].sort((a, b) => a.x - b.x);
    if (!chords.length) {
      // No chord anchors → fall back to plain x-based positioning.
      const ref = [...chordItems, ...lyricItems, ...beatItems];
      return [
        toPositioned(chordItems, ref),
        beatItems.length ? toPositioned(beatItems, ref) : '',
        toPositioned(lyricItems, ref),
      ];
    }
    // Estimate the rightmost bar's width from the average of preceding bar widths.
    const barXs = chords.map(c => c.x);
    const barWidths = [];
    for (let i = 1; i < barXs.length; i++) barWidths.push(barXs[i] - barXs[i - 1]);
    const avgBarPdfW = barWidths.length
      ? barWidths.reduce((a, b) => a + b, 0) / barWidths.length
      : 100;
    const lastBarEnd = barXs[barXs.length - 1] + avgBarPdfW;

    // Find (barIdx, beat) for any x. Lyrics before chord 0 → "pickup" beats in barIdx -1.
    function classify(x) {
      if (x < barXs[0]) {
        const span = avgBarPdfW;
        const beat = Math.max(0, Math.min(3.99, 4 + ((x - barXs[0]) / span) * 4));
        return { barIdx: -1, beat };
      }
      let i = 0;
      while (i < barXs.length - 1 && barXs[i + 1] <= x) i++;
      const start = barXs[i];
      const end = i + 1 < barXs.length ? barXs[i + 1] : lastBarEnd;
      const span = Math.max(end - start, 1);
      const beat = Math.max(0, Math.min(3.99, ((x - start) / span) * 4));
      return { barIdx: i, beat };
    }

    // Always reserve a pickup slot so bar 1 of every row starts at the same column.
    // Pickup lyrics (before the first chord) land in this leading slot; rows without
    // a pickup just leave it blank — keeps chord columns aligned vertically across rows.
    const pickupOffset = 1;
    const lineLen = (chords.length + pickupOffset) * BAR_WIDTH + 40;

    function renderRow(items) {
      const arr = Array(lineLen).fill(' ');
      const sorted = [...items].sort((a, b) => a.x - b.x);
      let nextFreeCol = 0;
      let prevHadTrailingSpace = false;
      for (const it of sorted) {
        const { barIdx, beat } = classify(it.x);
        let col = (barIdx + pickupOffset) * BAR_WIDTH + Math.round(beat * COLS_PER_BEAT);
        const minGap = prevHadTrailingSpace ? 2 : 1;
        if (col < nextFreeCol + (minGap - 1)) col = nextFreeCol + (minGap - 1);
        for (let j = 0; j < it.s.length && col + j < arr.length; j++) arr[col + j] = it.s[j];
        nextFreeCol = col + it.s.length + 1;
        prevHadTrailingSpace = !!it.hasTrailingSpace;
      }
      return arr.join('').trimEnd();
    }

    return [
      renderRow(chords),
      beatItems.length ? renderRow(beatItems) : '',
      renderRow(lyricItems),
    ];
  }

  function processLyrics(items) {
    const annotatedLyrics = [];
    const beatMarkers = [];
    for (const it of items) {
      const note = lookupNote(it.s);
      const dir = note ? note.dir : '';
      annotatedLyrics.push(dir ? { ...it, s: dir + it.s } : it);
      if (note && note.beat != null && note.measure != null) {
        const beatInt = Math.round(note.beat);
        if (Math.abs(note.beat - beatInt) < 0.1 && beatInt >= 2 && beatInt <= 4) {
          const key = `${note.measure}-${beatInt}`;
          if (!seenBeatInMeasure.has(key)) {
            seenBeatInMeasure.add(key);
            beatMarkers.push({ x: it.x, s: String(beatInt) });
          }
        }
      }
    }
    return { annotatedLyrics, beatMarkers };
  }

  const lines = [''];
  for (const p of pairs) {
    // Drop chord-only blocks (instrumental intros / fills) per user direction.
    if (p.type === 'chords-only') continue;

    if (p.type === 'pair') {
      const chordTokens  = p.chordRow.merged.filter(i => !/^\d+$/.test(i.s));
      const { annotatedLyrics, beatMarkers } = processLyrics(p.lyricRow.rawItems);
      const [chordOut, beatOut, lyricOut] = placeBarAligned(chordTokens, annotatedLyrics, beatMarkers);
      lines.push(chordOut);
      if (beatOut) lines.push(beatOut);
      lines.push(lyricOut);
    } else if (p.type === 'lyrics-only') {
      const { annotatedLyrics, beatMarkers } = processLyrics(p.row.rawItems);
      const refTokens = [...annotatedLyrics, ...beatMarkers];
      if (beatMarkers.length) lines.push(toPositioned(beatMarkers, refTokens));
      lines.push(toPositioned(annotatedLyrics, refTokens));
    }
  }
  return lines.join('\n');
}

// ── Render a PDF page to a canvas data-URL ───────────────────────────
async function renderPdfPages(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const urls = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const vp   = page.getViewport({ scale: 1.6 });
    const canvas = document.createElement('canvas');
    canvas.width  = vp.width;
    canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    urls.push(canvas.toDataURL('image/png'));
  }
  return urls;
}

// ── Song cache (localStorage) ────────────────────────────────────────
const API = 'http://localhost:5001';
async function fetchSavedSongs() {
  try {
    const res = await fetch(`${API}/songs`);
    return res.ok ? await res.json() : {};
  } catch { return {}; }
}
async function fetchMusicXml(filename) {
  try {
    const res = await fetch(`${API}/songs/${encodeURIComponent(filename)}/musicxml`);
    return res.ok ? await res.text() : null;
  } catch { return null; }
}
async function saveChartToCache(filename, chartText) {
  try {
    await fetch(`${API}/songs/${encodeURIComponent(filename)}/chart`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chartText }),
    });
  } catch { /* server may be down */ }
}
async function deleteSong(filename) {
  try { await fetch(`${API}/songs/${encodeURIComponent(filename)}`, { method: 'DELETE' }); }
  catch { /* server may be down */ }
}

// ── Chord chart parser ───────────────────────────────────────────────
const CHORD_TOKEN_RE = /^[A-G][#b]?(maj7?|min7?|m7?|dim7?|aug|sus[24]?|add\d?|b[59]|[79]|11|13)*(\/[A-G][#b]?)?(\d)?$/i;

function parseChordChart(text) {
  const SECTION_RE = /^\[(.+?)\]/;

  const tokenize = line => {
    const out = []; const re = /\S+/g; let m;
    while ((m = re.exec(line)) !== null) out.push({ token: m[0], col: m.index });
    return out;
  };

  const isChordLine = line => {
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    const n = tokens.filter(t => CHORD_TOKEN_RE.test(t) || /^\d+$/.test(t) || t === '-' || t === 'x').length;
    return n / tokens.length >= 0.5;
  };

  const parseLyricToken = token => {
    const ups   = (token.match(/\//g)  || []).length;
    const downs = (token.match(/\\/g) || []).length;
    const dir = ups > 0 && downs === 0 ? 'up'
              : downs > 0 && ups === 0 ? 'down'
              : ups > 0 && downs > 0   ? 'curve' : null;
    const word = token.replace(/[\/\\*()[\]]/g, '').replace(/^-+|-+$/g, '').trim();
    return word ? { word, dir } : null;
  };

  const sections = [];
  let cur = null, words = [];
  let pendingChords = null; // [{token, col}] — most recent chord line, columns preserved
  let lastChord = null;     // chord carried over from prior line (for pickups)

  for (const line of text.split('\n')) {
    if (!line.trim()) { pendingChords = null; continue; }
    const t = line.trim();
    const sm = t.match(SECTION_RE);
    if (sm) {
      if (cur !== null) sections.push({ name: cur, words });
      cur = sm[1]; words = []; pendingChords = null; lastChord = null;
      continue;
    }
    if (cur === null) continue;

    if (isChordLine(t)) {
      pendingChords = tokenize(line).filter(({ token }) => CHORD_TOKEN_RE.test(token));
      continue;
    }

    // Lyric line — attach the chord whose column is the latest one ≤ lyric col.
    for (const { token, col } of tokenize(line)) {
      const parsed = parseLyricToken(token);
      if (!parsed) continue;
      let chord = null;
      if (pendingChords && pendingChords.length) {
        for (const c of pendingChords) {
          if (c.col <= col) chord = c.token;
          else break;
        }
        if (!chord) chord = lastChord; // lyric appears before first chord on this line
      } else {
        chord = lastChord;
      }
      if (chord) lastChord = chord;
      words.push({ ...parsed, chord });
    }
    if (pendingChords && pendingChords.length) lastChord = pendingChords[pendingChords.length - 1].token;
    pendingChords = null;
  }
  if (cur !== null) sections.push({ name: cur, words });
  return sections;
}

function normalizeWord(w) { return (w || '').toLowerCase().replace(/[^a-z]/g, ''); }

function enrichNotesWithChart(notes, chartSections) {
  if (!chartSections || !chartSections.length) return notes;
  const words = chartSections.flatMap(sec =>
    sec.words.map(w => ({ ...w, section: sec.name }))
  );
  let ptr = 0;
  return notes.map(note => {
    const norm = normalizeWord(note.lyric);
    if (!norm || ptr >= words.length) return note;
    let best = null, bestScore = 0;
    for (let i = ptr; i < Math.min(ptr + 20, words.length); i++) {
      const nw = normalizeWord(words[i].word);
      if (!nw) continue;
      let lcp = 0;
      while (lcp < norm.length && lcp < nw.length && norm[lcp] === nw[lcp]) lcp++;
      const score = lcp / Math.max(norm.length, nw.length, 1);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best !== null && bestScore >= 0.45) {
      ptr = best + 1;
      return { ...note, section: words[best].section, dir: words[best].dir, chord: words[best].chord };
    }
    return note;
  });
}

function generateChordChart(notes) {
  if (!notes || !notes.length) return '';

  const dirs = notes.map((n, i) => {
    if (i === 0) return '';
    const pm = noteToMidi(notes[i - 1].note), cm = noteToMidi(n.note);
    if (!pm || !cm) return '';
    const diff = cm - pm;
    if (Math.abs(diff) >= 3) return diff > 0 ? '/' : '\\';
    if (i >= 2) {
      const pp = noteToMidi(notes[i - 2].note);
      if (pp) {
        const prev = pm - pp, cur = cm - pm;
        if (prev > 0 && cur < 0) return '\\';
        if (prev < 0 && cur > 0) return '/';
      }
    }
    return '';
  });

  const MIN_COL = 2;
  const TARGET   = 5;  // ideal notes per line
  const MIN_LINE = 4;  // combine short measures until we reach this
  const MAX_LINE = 8;  // never exceed this
  const hasMeasureData = notes.some(n => n.measure != null);
  const out = ['[Song]', ''];

  const renderLine = (slice, globalOffset) => {
    let cl = '', ll = '';
    slice.forEach((n, j) => {
      const lyric = (dirs[globalOffset + j] || '') + n.lyric;
      const w = Math.max(n.note.length + MIN_COL, lyric.length + MIN_COL);
      cl += n.note.padEnd(w);
      ll += lyric.padEnd(w);
    });
    out.push(cl.trimEnd()); out.push(ll.trimEnd()); out.push('');
  };

  if (hasMeasureData) {
    // Group notes by measure
    const measureMap = new Map();
    notes.forEach((n, i) => {
      const m = n.measure ?? 1;
      if (!measureMap.has(m)) measureMap.set(m, []);
      measureMap.get(m).push(i);
    });
    const mNums = [...measureMap.keys()].sort((a, b) => a - b);

    // Greedily bucket measures: keep adding the next measure until
    // we have >= MIN_LINE notes OR adding it would exceed MAX_LINE.
    let bucket = [];
    for (const mNum of mNums) {
      const idxs = measureMap.get(mNum);
      if (bucket.length > 0 && bucket.length + idxs.length > MAX_LINE) {
        // flush current bucket
        renderLine(bucket.map(i => notes[i]), bucket[0]);
        bucket = [];
      }
      bucket.push(...idxs);
      if (bucket.length >= MIN_LINE) {
        renderLine(bucket.map(i => notes[i]), bucket[0]);
        bucket = [];
      }
    }
    if (bucket.length) renderLine(bucket.map(i => notes[i]), bucket[0]);

  } else {
    // Fallback: fixed 5 per line
    for (let start = 0; start < notes.length; start += TARGET) {
      renderLine(notes.slice(start, start + TARGET), start);
    }
  }

  return out.join('\n');
}

function addDirectionHints(notes) {
  return notes.map((note, i) => {
    if (note.dir) return note;
    if (i === 0) return note;
    const pm = noteToMidi(notes[i - 1].note);
    const cm = noteToMidi(note.note);
    if (!pm || !cm) return note;
    const diff = cm - pm;
    // Big jump (≥3 semitones)
    if (Math.abs(diff) >= 3) return { ...note, dir: diff > 0 ? 'up' : 'down' };
    // Direction change
    if (i >= 2) {
      const pp = noteToMidi(notes[i - 2].note);
      if (pp) {
        const prev = pm - pp, cur = cm - pm;
        if (prev > 0 && cur < 0) return { ...note, dir: 'down' };
        if (prev < 0 && cur > 0) return { ...note, dir: 'up' };
      }
    }
    return note;
  });
}

// ── Melody Line ──────────────────────────────────────────────────────
const ML_W = 620, ML_H = 160, ML_PAD_V = 24, ML_PAD_H = 16, ML_VISIBLE = 15, ML_BEFORE = 4;

// Compute x positions and widths for visible notes based on duration
function computeLayout(visible) {
  const durations = visible.map(it => it.duration ?? 1);
  const total = durations.reduce((a, b) => a + b, 0) || visible.length;
  const avail = ML_W - ML_PAD_H * 2;
  let x = ML_PAD_H;
  return durations.map(d => {
    const w = (d / total) * avail;
    const cx = x + w / 2;
    x += w;
    return { cx, w };
  });
}

const MelodyLine = React.memo(function MelodyLine({ items, idx, canvasRef, octaveShift = 0, bpm = 120 }) {
  const semitones = octaveShift * 12;
  const sn = name => name ? shiftNote(name, semitones) : name;

  const start = Math.max(0, idx - ML_BEFORE);
  const end   = Math.min(items.length, start + ML_VISIBLE);
  const visible = items.slice(start, end);
  const layout = computeLayout(visible);
  const curVis = idx - start;

  const midis = visible.map(it => noteToMidi(sn(it.note))).filter(Boolean);
  const minM = Math.min(...midis) - 2;
  const maxM = Math.max(...midis) + 2;
  const range = Math.max(maxM - minM, 4);
  const midiToY = m => ML_H - ML_PAD_V - ((m - minM) / range) * (ML_H - ML_PAD_V * 2);

  const STATUS_DOT = { green: '#4caf50', yellow: '#ffeb3b', red: '#f44336' };

  return (
    <div style={{ position: 'relative', width: ML_W, margin: '0 auto' }}>
      <svg width={ML_W} height={ML_H} style={{ display: 'block', borderRadius: 12 }}>
        <rect width={ML_W} height={ML_H} fill="#111" rx={12} />

        {/* Current note highlight column */}
        {layout[curVis] && <rect x={layout[curVis].cx - layout[curVis].w / 2} y={0}
          width={layout[curVis].w} height={ML_H} fill="#4a9eff0d" rx={4} />}

        {/* Connecting lines */}
        {visible.map((item, i) => {
          if (i === 0) return null;
          const m1 = noteToMidi(sn(visible[i - 1].note));
          const m2 = noteToMidi(sn(item.note));
          if (!m1 || !m2) return null;
          const isPast = start + i <= idx;
          return <line key={`l${i}`} x1={layout[i-1].cx} y1={midiToY(m1)}
                       x2={layout[i].cx} y2={midiToY(m2)}
                       stroke={isPast ? '#4a9eff44' : '#333'} strokeWidth={2} />;
        })}

        {/* Note shapes — wider rect for longer notes, dot for short */}
        {visible.map((item, i) => {
          const gi = start + i;
          const midi = noteToMidi(sn(item.note));
          if (!midi) return null;
          const { cx, w } = layout[i];
          const y = midiToY(midi);
          const isCur  = gi === idx;
          const isPast = gi < idx;
          const dotColor = isCur ? '#4a9eff'
            : isPast ? (STATUS_DOT[item.status] ?? '#555') : '#444';
          const barW = Math.max(6, w - 8);
          const barH = isCur ? 8 : 5;
          return (
            <g key={`n${i}`}>
              <rect x={cx - barW / 2} y={y - barH / 2} width={barW} height={barH}
                    fill={dotColor} rx={barH / 2} />
              <text x={cx} y={y - 14} textAnchor="middle"
                    fill={isCur ? '#fff' : isPast ? '#888' : '#555'}
                    fontSize={isCur ? 12 : 10} fontWeight={isCur ? 'bold' : 'normal'}>
                {sn(item.note)}{isCur && item.dir ? (item.dir === 'up' ? ' ↑' : item.dir === 'down' ? ' ↓' : ' ↗↘') : ''}
              </text>
              {item.duration != null && (
                <text x={cx} y={y - 3} textAnchor="middle"
                      fill={isCur ? '#4a9eff99' : '#33333399'} fontSize={9}>
                  {((item.duration / bpm) * 60).toFixed(1)}s
                </text>
              )}
              <text x={cx} y={ML_H - 8} textAnchor="middle"
                    fill={isCur ? '#fff' : isPast ? '#666' : '#444'}
                    fontSize={isCur ? 13 : 11} fontWeight={isCur ? 'bold' : 'normal'}>
                {item.lyric}
              </text>
            </g>
          );
        })}
      </svg>
      <canvas ref={canvasRef} width={ML_W} height={ML_H}
              style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', borderRadius: 12 }} />
    </div>
  );
}, (prev, next) => {
  if (prev.idx !== next.idx || prev.octaveShift !== next.octaveShift || prev.bpm !== next.bpm) return false;
  // re-render if any visible item's status changed
  const s = Math.max(0, prev.idx - ML_BEFORE);
  const e = Math.min(prev.items.length, s + ML_VISIBLE);
  for (let i = s; i < e; i++) {
    if (prev.items[i] !== next.items[i]) return false;
  }
  return true;
});

// ── Chart Display ────────────────────────────────────
const CHORD_BOX_RE = /^[A-G][#b]?(maj7?|min7?|m7?|dim7?|aug|sus[24]?|add\d?|b[59]|[79]|11|13)*(\/[A-G][#b]?)?\d?$/i;

function renderChordTokens(line) {
  const parts = [];
  let i = 0;
  while (i < line.length) {
    if (/[A-G]/.test(line[i])) {
      let j = i;
      while (j < line.length && line[j] !== " ") j++;
      const tok = line.slice(i, j);
      parts.push({ chord: CHORD_BOX_RE.test(tok), text: tok });
      i = j;
    } else {
      let j = i;
      while (j < line.length && !/[A-G]/.test(line[j])) j++;
      parts.push({ chord: false, text: line.slice(i, j) });
      i = j;
    }
  }
  return parts.map((p, idx) =>
    p.chord
      ? <span key={idx} style={{
          background: "#1a2d42",
          border: "1px solid #2a4060",
          borderRadius: 5,
          padding: "2px 7px",
          color: "#7ab8e8",
          fontWeight: "bold",
          lineHeight: 1,
        }}>{p.text}</span>
      : <span key={idx}>{p.text}</span>
  );
}

function ChartDisplay({ chartText, currentSection }) {
  const activeRef = useRef(null);
  const containerRef = useRef(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [currentSection]);

  // Auto-fit: scale font so the longest line fits the container width without horizontal scroll
  const longest = chartText
    ? chartText.split('\n').reduce((m, l) => Math.max(m, l.length), 1)
    : 1;
  useEffect(() => {
    if (!containerRef.current) return;
    const fit = () => {
      const w = containerRef.current?.clientWidth || 0;
      // monospace char width ≈ 0.6 × fontSize at the chord-row 12px baseline
      // available width / longest / 0.6 = fontSize that just fits
      const fitFs = (w - 4) / Math.max(longest, 1) / 0.6;
      // baseline chord size = 12; clamp resulting scale to [0.55, 1.1]
      setScale(Math.max(0.55, Math.min(1.1, fitFs / 12)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [longest]);

  if (!chartText) return null;
  const lines = chartText.split('\n');
  let activeSec = null;

  const fs = (n) => `${(n * scale).toFixed(2)}px`;

  return (
    <div ref={containerRef} style={{ fontFamily: "monospace", fontSize: fs(13) }}>
      {lines.map((line, i) => {
        const secMatch = line.trim().match(/^\[(.+)\]$/);
        if (secMatch) activeSec = secMatch[1];
        const isHeader   = !!secMatch;
        const isActive   = isHeader && activeSec === currentSection;
        const firstTok   = line.trimStart().split(/\s+/)[0] || "";
        const isChordLine = !isHeader && line.trim() !== "" && /^[A-G]/.test(firstTok);
        const isEmpty    = line.trim() === "";
        return (
          <div key={i} ref={isActive ? activeRef : null} style={{
            whiteSpace: "pre",
            color: isHeader
              ? (isActive ? "#4a9eff" : "#888")
              : isChordLine ? "#aaa" : "#ddd",
            fontWeight: isHeader ? "bold" : "normal",
            background: isActive ? "#0d1f35" : "transparent",
            padding: isHeader ? "4px 8px" : "0",
            borderRadius: isHeader ? 6 : 0,
            marginTop: isHeader ? 10 : 0,
            marginBottom: isHeader ? 2 : 0,
            fontSize: isHeader ? fs(14) : isChordLine ? fs(12) : fs(13),
            lineHeight: isEmpty ? "0.4" : isChordLine ? "1.3" : "1.25",
          }}>
            {isChordLine ? renderChordTokens(line) : (line || " ")}
          </div>
        );
      })}
    </div>
  );
}

// ── Lyric Display ────────────────────────────────────────────────────
const STATUS_COLOR = { green: '#4caf50', yellow: '#ffeb3b', red: '#f44336' };

function LyricDisplay({ items, idx }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) {
      const active = ref.current.querySelector('[data-active="true"]');
      if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [idx]);

  return (
    <div ref={ref} style={{
      display: 'flex', flexWrap: 'wrap', gap: '6px 10px',
      padding: '8px 10px', background: '#111', borderRadius: 8, marginTop: 8,
      maxHeight: 160, overflowY: 'auto',
    }}>
      {items.map((item, i) => {
        const past = i < idx;
        const active = i === idx;
        const color = past ? (STATUS_COLOR[item.status] ?? '#555') : active ? '#fff' : '#444';
        return (
          <span key={i} data-active={active ? 'true' : 'false'} style={{
            color,
            fontSize: active ? 16 : 12,
            fontWeight: active ? 'bold' : 'normal',
            padding: active ? '1px 6px' : '0',
            borderRadius: 4,
            background: active ? '#0f2340' : 'transparent',
            transition: 'all 0.15s',
            whiteSpace: 'nowrap',
          }}>{item.lyric}</span>
        );
      })}
    </div>
  );
}

// ── Setup: note + lyric editor ───────────────────────────────────────
function SetupEditor({ initialLyrics, prefillRows, omrError, onStart }) {
  const [rows, setRows] = useState(() =>
    prefillRows
      ? prefillRows.map(r => ({ lyric: r.lyric || '', note: r.note || '', duration: r.duration, measure: r.measure, beat: r.beat }))
      : initialLyrics.map(l => ({ lyric: l, note: '', duration: undefined }))
  );
  const [bulkNotes, setBulkNotes] = useState('');

  const updateRow = (i, field, val) =>
    setRows(r => r.map((row, j) => j === i ? { ...row, [field]: val } : row));

  const addRow    = () => setRows(r => [...r, { lyric: '', note: '' }]);
  const removeRow = i  => setRows(r => r.filter((_, j) => j !== i));

  const applyBulk = () => {
    const notes = bulkNotes.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    setRows(r => r.map((row, i) => ({ ...row, note: notes[i] ?? row.note })));
  };

  const autoFilled = prefillRows && prefillRows.length > 0;
  const canStart   = rows.length > 0 && rows.every(r => noteToMidi(r.note) != null);

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: 20 }}>
      <h2 style={{ color: '#4a9eff', marginBottom: 16 }}>Set Up Your Song</h2>

      {autoFilled ? (
        <div style={{ marginBottom: 16, background: '#0f2a0f', border: '1px solid #2a6a2a',
                      padding: 12, borderRadius: 8, color: '#4caf50', fontSize: 13 }}>
          ✓ Notes extracted automatically via Audiveris — {rows.length} notes found.
          Review below and fix any errors before starting.
        </div>
      ) : (
        <div style={{ marginBottom: 16, background: '#1a1a1a', padding: 12, borderRadius: 8,
                      borderLeft: '3px solid #f44336', color: '#aaa', fontSize: 13 }}>
          <strong style={{ color: '#f44336' }}>OMR failed:</strong>{' '}
          {omrError || 'Could not reach the backend — run python server.py first.'}
          <br /><span style={{ color: '#666', fontSize: 12 }}>Enter notes manually below or use the quick-fill box.</span>
        </div>
      )}

      {!autoFilled && (
        <div style={{ marginBottom: 12, background: '#1a1a1a', padding: 10, borderRadius: 8 }}>
          <label style={{ display: 'block', marginBottom: 6, color: '#888', fontSize: 12 }}>
            Quick-fill all notes (comma-separated):
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={bulkNotes} onChange={e => setBulkNotes(e.target.value)}
              placeholder="C4, D4, E4, F4 ..."
              style={{ flex: 1, background: '#0d0d0d', color: '#fff', border: '1px solid #333',
                       borderRadius: 6, padding: '6px 10px', fontFamily: 'monospace', fontSize: 13 }} />
            <button onClick={applyBulk}
              style={{ background: '#1e3a5f', color: '#4a9eff', border: 'none', borderRadius: 6,
                       padding: '6px 14px', cursor: 'pointer', whiteSpace: 'nowrap' }}>Fill →</button>
          </div>
        </div>
      )}

      <div style={{ background: '#1a1a1a', borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 32px',
                      padding: '8px 12px', borderBottom: '1px solid #2a2a2a',
                      color: '#666', fontSize: 12 }}>
          <span>LYRIC</span><span>NOTE (e.g. A4)</span><span />
        </div>
        <div style={{ maxHeight: 340, overflowY: 'auto' }}>
          {rows.map((row, i) => {
            const valid = noteToMidi(row.note) != null;
            return (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 32px',
                                    padding: '6px 12px', borderBottom: '1px solid #1e1e1e',
                                    alignItems: 'center' }}>
                <input value={row.lyric} onChange={e => updateRow(i, 'lyric', e.target.value)}
                  style={{ background: '#0d0d0d', color: '#ddd', border: '1px solid #2a2a2a',
                           borderRadius: 4, padding: '4px 8px' }} />
                <input value={row.note} onChange={e => updateRow(i, 'note', e.target.value)}
                  placeholder="C4"
                  style={{ background: '#0d0d0d', color: valid ? '#4a9eff' : '#f44336',
                           border: `1px solid ${valid || !row.note ? '#2a2a2a' : '#f44336'}`,
                           borderRadius: 4, padding: '4px 8px', fontFamily: 'monospace',
                           marginLeft: 8 }} />
                <button onClick={() => removeRow(i)}
                  style={{ background: 'none', border: 'none', color: '#555',
                           cursor: 'pointer', fontSize: 16, textAlign: 'center' }}>×</button>
              </div>
            );
          })}
        </div>
        <div style={{ padding: '8px 12px' }}>
          <button onClick={addRow}
            style={{ background: 'none', border: '1px dashed #333', color: '#555',
                     borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 13 }}>
            + Add row
          </button>
        </div>
      </div>

      <button onClick={() => onStart(rows)} disabled={!canStart}
        style={{ width: '100%', padding: '12px', fontSize: 16, fontWeight: 'bold',
                 background: canStart ? '#4a9eff' : '#1a2a3a',
                 color: canStart ? '#000' : '#444',
                 border: 'none', borderRadius: 8, cursor: canStart ? 'pointer' : 'default' }}>
        Start Practice →
      </button>
    </div>
  );
}

// ── Recurring pattern detection ──────────────────────────────────────
function findRecurringPatterns(items, curMeasure, windowMeasures = 2) {
  if (!curMeasure || items.length < 6) return [];
  const win = items.filter(n => n.measure >= curMeasure && n.measure < curMeasure + windowMeasures);
  if (win.length < 3) return [];
  const targetIvs = [];
  for (let i = 1; i < Math.min(win.length, 7); i++) {
    const m1 = noteToMidi(win[i-1].note), m2 = noteToMidi(win[i].note);
    if (m1 && m2) targetIvs.push(m2 - m1);
  }
  if (targetIvs.length < 2) return [];
  const allMeasures = [...new Set(items.map(n => n.measure))].sort((a, b) => a - b);
  const results = [];
  for (const startM of allMeasures) {
    if (startM >= curMeasure - 1 && startM <= curMeasure + windowMeasures) continue;
    const cand = items.filter(n => n.measure >= startM && n.measure < startM + windowMeasures);
    if (cand.length < 3) continue;
    const ivs = [];
    for (let i = 1; i < Math.min(cand.length, 7); i++) {
      const m1 = noteToMidi(cand[i-1].note), m2 = noteToMidi(cand[i].note);
      if (m1 && m2) ivs.push(m2 - m1);
    }
    const len = Math.min(targetIvs.length, ivs.length);
    if (len < 2) continue;
    const score = ivs.slice(0, len).filter((v, i) => v === targetIvs[i]).length / len;
    if (score >= 0.75) results.push({ measure: startM, section: cand[0]?.section });
  }
  return results;
}

// ── Section label (right-column panels) ──────────────────────────────
function SectionLabel({ children }) {
  return (
    <div style={{ color: '#999', fontSize: 11, marginTop: 4, marginBottom: 2,
                  textTransform: 'uppercase', letterSpacing: 1, flexShrink: 0,
                  paddingBottom: 3, borderBottom: '1px solid #222' }}>
      {children}
    </div>
  );
}

// ── Container size hook ───────────────────────────────────────────────
function useSize() {
  const ref = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setSize({ w: Math.floor(width), h: Math.floor(height) });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

// ── Real Sheet Music (OSMD) ───────────────────────────────────────────
// Renders MusicXML as proper engraved notation: 5-line staff, treble clef,
// noteheads with stems/beams/flags, key signature, bar lines, lyrics.
// Cursor walks to the current note index (mapped from items[].idx → note in score).
function SheetMusicOSMD({ musicXml, idx }) {
  const containerRef = useRef(null);
  const osmdRef = useRef(null);
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);

  // Mount / load
  useEffect(() => {
    if (!containerRef.current || !musicXml) return;
    let cancelled = false;
    setReady(false);
    setError(null);
    // Tear down any prior instance before creating a new one (e.g., on song swap).
    if (osmdRef.current) {
      try { osmdRef.current.clear(); } catch {}
      osmdRef.current = null;
    }
    containerRef.current.innerHTML = '';
    const osmd = new OpenSheetMusicDisplay(containerRef.current, {
      autoResize: true,
      backend: 'svg',
      drawTitle: false,
      drawSubtitle: false,
      drawComposer: false,
      drawCredits: false,
      drawPartNames: false,
      drawingParameters: 'compact',
      darkMode: true,
      pageBackgroundColor: '#0d0d0d',
      defaultColorNotehead: '#dddddd',
      defaultColorStem: '#dddddd',
      defaultColorRest: '#dddddd',
      defaultColorLabel: '#aaaaaa',
      defaultColorLyric: '#aaaaaa',
    });
    osmdRef.current = osmd;
    osmd.load(musicXml)
      .then(() => {
        if (cancelled) return;
        osmd.render();
        try { osmd.cursor.show(); } catch {}
        setReady(true);
      })
      .catch(err => { if (!cancelled) setError(err?.message || 'Failed to load score'); });
    return () => {
      cancelled = true;
      if (osmdRef.current) {
        try { osmdRef.current.clear(); } catch {}
        osmdRef.current = null;
      }
    };
  }, [musicXml]);

  // Advance the OSMD cursor to follow the practice index. OSMD's cursor walks
  // note-by-note; reset to start and step forward `idx` times when idx changes.
  useEffect(() => {
    const osmd = osmdRef.current;
    if (!osmd || !ready) return;
    try {
      osmd.cursor.reset();
      for (let i = 0; i < idx; i++) osmd.cursor.next();
    } catch {}
  }, [idx, ready]);

  if (!musicXml) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#555', fontSize: 12, padding: 12 }}>
        Sheet music not available for this song.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {error && (
        <div style={{ color: '#f44336', fontSize: 11, padding: 4 }}>Score render error: {error}</div>
      )}
      <div ref={containerRef} style={{
        flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
        background: '#0d0d0d', borderRadius: 6, padding: 4,
      }} />
    </div>
  );
}

// ── Sheet Music Mini View (legacy: pitch-time chart, used as fallback) ────
function SheetMusicBars({ items, idx }) {
  const [svgRef, { w, h }] = useSize();
  const PL = 12, PR = 12, PT = 24, PB = 32;
  const drawW = Math.max((w || 0) - PL - PR, 1);
  const drawH = Math.max((h || 0) - PT - PB, 1);

  const VISIBLE = w > 520 ? 12 : w > 380 ? 8 : 6;
  const start = Math.max(0, idx - Math.floor(VISIBLE / 4));
  const end   = Math.min(items.length, start + VISIBLE);
  const vis   = items.slice(start, end);

  const hasMeasures  = vis[0]?.measure != null;
  const curMeasure   = items[idx]?.measure;
  const patterns     = hasMeasures && curMeasure ? findRecurringPatterns(items, curMeasure) : [];
  const patternLabel = patterns.length
    ? [...new Set(patterns.map(p => p.section || `m.${p.measure}`))].slice(0, 3).join(', ')
    : null;

  const midis = vis.map(n => noteToMidi(n.note) ?? 0).filter(m => m > 0);
  const minM  = midis.length ? Math.min(...midis) - 2 : 60;
  const maxM  = midis.length ? Math.max(...midis) + 2 : 72;
  const range = Math.max(maxM - minM, 6);
  const noteW = vis.length ? drawW / vis.length : drawW;
  const cx = i => PL + (i + 0.5) * noteW;
  const cy = n => {
    const m = noteToMidi(n.note) ?? 0;
    return m > 0 ? PT + drawH - ((m - minM) / range) * drawH : PT + drawH / 2;
  };

  const barLines = [];
  if (hasMeasures && vis.length) {
    let lastM = vis[0].measure;
    for (let i = 1; i < vis.length; i++) {
      if (vis[i].measure != null && vis[i].measure !== lastM) {
        barLines.push({ x: PL + i * noteW, label: vis[i].measure });
        lastM = vis[i].measure;
      }
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '4px 0', flexShrink: 0 }}>
        <span style={{ color: '#666', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>
          {hasMeasures && curMeasure ? `Bars ${curMeasure}–${curMeasure + 1}` : `Notes ${start + 1}–${end}`}
        </span>
        {patternLabel && <span style={{ color: '#ff9800', fontSize: 11 }}>↻ {patternLabel}</span>}
      </div>
      <div ref={svgRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <svg viewBox={w > 0 && h > 0 ? `0 0 ${w} ${h}` : '0 0 1 1'}
             preserveAspectRatio="none"
             style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                      display: 'block', background: '#0d0d0d', borderRadius: 6 }}>
          {w > 0 && h > 0 && vis.length > 0 && midis.length > 0 && (
            <>
              {Array.from({ length: range + 1 }, (_, i) => {
                const pc = ((minM + i) % 12 + 12) % 12;
                if (![0,2,4,5,7,9,11].includes(pc)) return null;
                const y = PT + drawH - (i / range) * drawH;
                return <line key={i} x1={PL} x2={w - PR} y1={y} y2={y} stroke="#ffffff08" strokeWidth={1} />;
              })}
              {barLines.map((bl, i) => (
                <g key={i}>
                  <line x1={bl.x} x2={bl.x} y1={PT} y2={PT + drawH} stroke="#444" strokeWidth={1} />
                  <text x={bl.x + 2} y={PT - 4} fill="#555" fontSize={9} fontFamily="sans-serif">m.{bl.label}</text>
                </g>
              ))}
              {vis.map((n, i) => {
                const gi = start + i;
                const x = cx(i), y = cy(n);
                const isCur = gi === idx, isPast = gi < idx;
                const fill = isCur ? '#4a9eff'
                  : isPast ? ({ green: '#4caf50', yellow: '#ffeb3b', red: '#f44336' }[n.status] ?? '#555')
                  : '#1a3a5a';
                return (
                  <g key={i}>
                    <line x1={x} x2={x} y1={y + 9} y2={PT + drawH} stroke={fill} strokeWidth={isCur ? 4.5 : 1.5} opacity={0.3} />
                    <rect x={x - 15} y={y - 9} width={30} height={18} fill={fill} rx={9} />
                    {isCur && (() => {
                      const noteFs = Math.max(14, Math.min(30, noteW * 0.6));
                      return (
                        <text x={x} y={y - noteFs * 0.75} textAnchor="middle" fill="#4a9eff"
                              fontSize={noteFs} fontFamily="sans-serif" fontWeight="bold">
                          {n.note}
                        </text>
                      );
                    })()}
                    {(() => {
                      const raw = n.lyric || '';
                      if (!raw) return null;
                      const lyricFs = Math.max(10, Math.min(20, noteW * 0.55));
                      const charW = lyricFs * 0.55;
                      const maxChars = Math.floor((noteW - 4) / charW);
                      if (maxChars < 1) return null;
                      const word = raw.length > maxChars
                        ? (maxChars >= 2 ? raw.slice(0, maxChars - 1) + '…' : raw.slice(0, 1))
                        : raw;
                      return (
                        <text x={x} y={h - 6} textAnchor="middle"
                              fill={isCur ? '#ddd' : isPast ? '#555' : '#333'} fontSize={lyricFs} fontFamily="sans-serif">
                          {word}
                        </text>
                      );
                    })()}
                  </g>
                );
              })}
            </>
          )}
        </svg>
      </div>
    </div>
  );
}

// ── Guitar Fretboard ──────────────────────────────────────────────────
const GUITAR_OPEN_MIDI = [64, 59, 55, 50, 45, 40]; // e B G D A E
const GUITAR_STRING_LABELS = ['e', 'B', 'G', 'D', 'A', 'E'];
const PENTA_MAJOR = [0, 2, 4, 7, 9];
const PENTA_MINOR = [0, 3, 5, 7, 10];
const SCALE_MAJOR = [0, 2, 4, 5, 7, 9, 11];
const SCALE_MINOR = [0, 2, 3, 5, 7, 8, 10];

function detectKey(items) {
  const pcCount = new Array(12).fill(0);
  for (const n of items) {
    const m = noteToMidi(n.note);
    if (m != null) pcCount[((m % 12) + 12) % 12]++;
  }
  let bestRoot = 0, bestMode = 'major', bestScore = -1;
  for (let root = 0; root < 12; root++) {
    for (const [ivs, mode] of [[SCALE_MAJOR, 'major'], [SCALE_MINOR, 'minor']]) {
      const score = ivs.reduce((s, iv) => s + pcCount[(root + iv) % 12], 0);
      if (score > bestScore) { bestScore = score; bestRoot = root; bestMode = mode; }
    }
  }
  return { root: bestRoot, mode: bestMode };
}

// Pick the neck position whose 5-fret window (index finger + pinky stretch)
// covers the most actually-played notes, weighted by frequency. Convention
// matches GuitarFretboard rendering: pos returned is "fret before index" so
// pos=8 means "Fret 9" with visible window [9, 13]. A note counts if ANY of
// its string/fret candidates falls in the window. Falls back to scale-density
// scoring when no song data is available.
function bestNeckPos(items, scalePCs) {
  const freq = new Map();
  const cands = new Map();
  if (items && items.length) {
    for (const n of items) {
      const m = noteToMidi(n.note);
      if (m == null) continue;
      freq.set(m, (freq.get(m) || 0) + 1);
      if (!cands.has(m)) {
        const list = [];
        for (let s = 0; s < GUITAR_OPEN_MIDI.length; s++) {
          const f = m - GUITAR_OPEN_MIDI[s];
          if (f >= 0 && f <= 22) list.push(f);
        }
        cands.set(m, list);
      }
    }
  }
  let bestPos = 0, bestScore = -1;
  for (let pos = 0; pos <= 17; pos++) {
    const lo = pos === 0 ? 0 : pos + 1;
    const hi = pos + 5;
    let score = 0;
    if (freq.size) {
      for (const [m, fs] of cands) {
        if (fs.some(f => f >= lo && f <= hi)) score += freq.get(m);
      }
    } else if (scalePCs) {
      for (let s = 0; s < GUITAR_OPEN_MIDI.length; s++) {
        for (let f = lo; f <= hi; f++) {
          if (scalePCs.has(((GUITAR_OPEN_MIDI[s] + f) % 12 + 12) % 12)) score++;
        }
      }
    }
    if (score > bestScore) { bestScore = score; bestPos = pos; }
  }
  return bestPos;
}

const CHORD_SHAPES = {
  // Major
  'C':  { frets: [-1, 3, 2, 0, 1, 0] },
  'C#': { frets: [-1, 4, 6, 6, 6, 4], barre: 4 },
  'D':  { frets: [-1, -1, 0, 2, 3, 2] },
  'D#': { frets: [-1, 6, 8, 8, 8, 6], barre: 6 },
  'E':  { frets: [0, 2, 2, 1, 0, 0] },
  'F':  { frets: [1, 3, 3, 2, 1, 1], barre: 1 },
  'F#': { frets: [2, 4, 4, 3, 2, 2], barre: 2 },
  'G':  { frets: [3, 2, 0, 0, 0, 3] },
  'G#': { frets: [4, 6, 6, 5, 4, 4], barre: 4 },
  'A':  { frets: [-1, 0, 2, 2, 2, 0] },
  'A#': { frets: [-1, 1, 3, 3, 3, 1], barre: 1 },
  'B':  { frets: [-1, 2, 4, 4, 4, 2], barre: 2 },
  // Minor
  'Cm':  { frets: [-1, 3, 5, 5, 4, 3], barre: 3 },
  'C#m': { frets: [-1, 4, 6, 6, 5, 4], barre: 4 },
  'Dm':  { frets: [-1, -1, 0, 2, 3, 1] },
  'D#m': { frets: [-1, 6, 8, 8, 7, 6], barre: 6 },
  'Em':  { frets: [0, 2, 2, 0, 0, 0] },
  'Fm':  { frets: [1, 3, 3, 1, 1, 1], barre: 1 },
  'F#m': { frets: [2, 4, 4, 2, 2, 2], barre: 2 },
  'Gm':  { frets: [3, 5, 5, 3, 3, 3], barre: 3 },
  'G#m': { frets: [4, 6, 6, 4, 4, 4], barre: 4 },
  'Am':  { frets: [-1, 0, 2, 2, 1, 0] },
  'A#m': { frets: [-1, 1, 3, 3, 2, 1], barre: 1 },
  'Bm':  { frets: [-1, 2, 4, 4, 3, 2], barre: 2 },
  // 7
  'C7': { frets: [-1, 3, 2, 3, 1, 0] }, 'D7': { frets: [-1, -1, 0, 2, 1, 2] },
  'E7': { frets: [0, 2, 0, 1, 0, 0] },  'F7': { frets: [1, 3, 1, 2, 1, 1], barre: 1 },
  'G7': { frets: [3, 2, 0, 0, 0, 1] },  'A7': { frets: [-1, 0, 2, 0, 2, 0] },
  'B7': { frets: [-1, 2, 1, 2, 0, 2] },
  // maj7
  'Cmaj7': { frets: [-1, 3, 2, 0, 0, 0] }, 'Dmaj7': { frets: [-1, -1, 0, 2, 2, 2] },
  'Emaj7': { frets: [0, 2, 1, 1, 0, 0] },  'Fmaj7': { frets: [-1, -1, 3, 2, 1, 0] },
  'Gmaj7': { frets: [3, 2, 0, 0, 0, 2] },  'Amaj7': { frets: [-1, 0, 2, 1, 2, 0] },
  // m7
  'Am7': { frets: [-1, 0, 2, 0, 1, 0] }, 'Dm7': { frets: [-1, -1, 0, 2, 1, 1] },
  'Em7': { frets: [0, 2, 2, 0, 3, 0] },
  // sus
  'Asus4': { frets: [-1, 0, 2, 2, 3, 0] }, 'Dsus4': { frets: [-1, -1, 0, 2, 3, 3] },
  'Esus4': { frets: [0, 2, 2, 2, 0, 0] },
};

const ENHARMONIC = { Db:'C#', Eb:'D#', Gb:'F#', Ab:'G#', Bb:'A#' };

function lookupChord(name) {
  if (!name) return null;
  let core = name.split('/')[0].trim();
  const m = core.match(/^([A-G])([#b]?)(.*)$/);
  if (!m) return null;
  let [, root, acc, rest] = m;
  if (acc === 'b') {
    const en = ENHARMONIC[root + 'b'];
    if (en) { root = en[0]; acc = en[1] || ''; }
  }
  const norm = root + acc + rest;
  if (CHORD_SHAPES[norm]) return CHORD_SHAPES[norm];
  // Strip extensions, keep root + minor
  const isMinor = rest.startsWith('m') && !rest.startsWith('maj');
  const basic = root + acc + (isMinor ? 'm' : '');
  return CHORD_SHAPES[basic] || null;
}

function ChordDiagram({ chord, label, size = 'lg' }) {
  if (!chord) return null;
  const shape = lookupChord(chord);
  const W = size === 'lg' ? 110 : size === 'sm' ? 78 : 54;
  const PADX = size === 'xs' ? 8 : 14;
  const PADTOP = size === 'xs' ? 18 : 26;
  const PADBOT = size === 'xs' ? 6 : 10;
  const NUM_FRETS = 5, NUM_STRINGS = 6;
  const innerW = W - PADX * 2;
  const stringSp = innerW / (NUM_STRINGS - 1);
  const fretSp = stringSp * 0.95;
  const innerH = fretSp * NUM_FRETS;
  const H = innerH + PADTOP + PADBOT;
  const labelColor = size === 'lg' ? '#ffb347' : '#888';
  const nameSize   = size === 'lg' ? 18 : size === 'sm' ? 14 : 11;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: W }}>
      {label && <div style={{ color: '#555', fontSize: 9, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 2 }}>{label}</div>}
      <div style={{ color: labelColor, fontSize: nameSize, fontWeight: 700, fontFamily: 'monospace', marginBottom: 4 }}>{chord}</div>
      {shape ? (() => {
        const positive = shape.frets.filter(f => f > 0);
        const maxF = positive.length ? Math.max(...positive) : 0;
        const minF = positive.length ? Math.min(...positive) : 0;
        const baseFret = (minF > 1 && maxF - minF < NUM_FRETS) ? minF : 1;
        const isOpenPos = baseFret === 1;
        return (
          <svg width={W} height={H} style={{ display: 'block' }}>
            {/* nut or position label */}
            {isOpenPos
              ? <rect x={PADX - 1} y={PADTOP - 3} width={innerW + 2} height={3} fill="#aaa" />
              : <text x={PADX - 6} y={PADTOP + fretSp / 2 + 3} textAnchor="end" fill="#888" fontSize={10} fontFamily="monospace">{baseFret}fr</text>}
            {/* fret lines */}
            {Array.from({ length: NUM_FRETS + 1 }, (_, i) => (
              <line key={'f' + i} x1={PADX} x2={PADX + innerW} y1={PADTOP + i * fretSp} y2={PADTOP + i * fretSp} stroke="#3a3a3a" strokeWidth={1} />
            ))}
            {/* strings */}
            {Array.from({ length: NUM_STRINGS }, (_, s) => (
              <line key={'s' + s} x1={PADX + s * stringSp} x2={PADX + s * stringSp} y1={PADTOP} y2={PADTOP + innerH} stroke="#555" strokeWidth={0.8} />
            ))}
            {/* open / muted markers above nut */}
            {shape.frets.map((f, idx) => {
              const s = NUM_STRINGS - 1 - idx; // shape order: low-E first → string 6
              const x = PADX + s * stringSp;
              if (f === -1) return <text key={'m' + idx} x={x} y={PADTOP - 6} textAnchor="middle" fill="#777" fontSize={11} fontFamily="monospace">×</text>;
              if (f === 0)  return <circle key={'o' + idx} cx={x} cy={PADTOP - 8} r={3.5} fill="none" stroke="#bbb" strokeWidth={1.2} />;
              return null;
            })}
            {/* barre */}
            {shape.barre && (() => {
              const barreF = shape.barre;
              const stringsAtBarre = shape.frets.map((f, i) => f === barreF ? (NUM_STRINGS - 1 - i) : -1).filter(s => s >= 0);
              if (stringsAtBarre.length < 2) return null;
              const sMin = Math.min(...stringsAtBarre), sMax = Math.max(...stringsAtBarre);
              const y = PADTOP + (barreF - baseFret + 0.5) * fretSp;
              return <line x1={PADX + sMin * stringSp} x2={PADX + sMax * stringSp} y1={y} y2={y} stroke="#ffb347" strokeWidth={fretSp * 0.55} strokeLinecap="round" opacity={0.85} />;
            })()}
            {/* finger dots */}
            {shape.frets.map((f, idx) => {
              if (f <= 0) return null;
              const s = NUM_STRINGS - 1 - idx;
              const x = PADX + s * stringSp;
              const y = PADTOP + (f - baseFret + 0.5) * fretSp;
              return <circle key={'d' + idx} cx={x} cy={y} r={Math.max(1, fretSp * 0.32)} fill="#ffb347" />;
            })}
          </svg>
        );
      })() : (
        <div style={{ width: W, height: H, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      border: '1px dashed #333', borderRadius: 4, color: '#555', fontSize: 10, textAlign: 'center', padding: 4 }}>
          shape not in library
        </div>
      )}
    </div>
  );
}

function diatonicChords(items) {
  if (!items.length) return [];
  const { root, mode } = detectKey(items);
  const flats = usesFlats(root, mode);
  const degrees = mode === 'major'
    ? [{iv:0,q:''}, {iv:5,q:''}, {iv:7,q:''}, {iv:9,q:'m'}]   // I IV V vi
    : [{iv:0,q:'m'}, {iv:5,q:'m'}, {iv:7,q:'m'}, {iv:10,q:''}, {iv:3,q:''}, {iv:8,q:''}]; // i iv v VII III VI
  return degrees.map(({iv,q}) => pcName((root + iv) % 12, flats) + q);
}

function ChordRail({ items, idx }) {
  const curChord = (() => {
    for (let i = Math.min(idx, items.length - 1); i >= 0; i--) if (items[i].chord) return items[i].chord;
    return null;
  })();
  let nextChord = null, nextIdx = -1;
  for (let i = idx + 1; i < items.length; i++) {
    if (items[i].chord && items[i].chord !== curChord) { nextChord = items[i].chord; nextIdx = i; break; }
  }
  const wordsToNext = nextIdx > -1 ? nextIdx - idx : null;

  if (curChord || nextChord) {
    return (
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', gap: 18,
                    padding: '8px 4px', background: '#0d0d0d', borderRadius: 6, flexShrink: 0 }}>
        <ChordDiagram chord={curChord} label="Now" size="lg" />
        {nextChord && (
          <ChordDiagram chord={nextChord} label={`Next · ${wordsToNext}w`} size="sm" />
        )}
      </div>
    );
  }

  // Fallback: show diatonic chord suggestions for the detected key
  const suggestions = diatonicChords(items);
  if (!suggestions.length) return null;
  const { root, mode } = detectKey(items);
  const keyLabel = pcName(root, usesFlats(root, mode)) + (mode === 'major' ? ' maj' : ' min');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4,
                  padding: '6px 4px', background: '#0d0d0d', borderRadius: 6, flexShrink: 0, position: 'relative' }}>
      <div style={{ color: '#666', fontSize: 9, textTransform: 'uppercase', letterSpacing: 1, paddingLeft: 8 }}>
        Diatonic · {keyLabel} <span style={{ color: '#444' }}>· {suggestions.length} chords (scroll →)</span>
      </div>
      <div style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 2,
                    maskImage: 'linear-gradient(to right, black 92%, transparent 100%)',
                    WebkitMaskImage: 'linear-gradient(to right, black 92%, transparent 100%)' }}>
        {suggestions.map(c => <ChordDiagram key={c} chord={c} size="xs" />)}
      </div>
    </div>
  );
}

const DURATION_LABELS = [
  { beats: 4,     label: 'w'  }, { beats: 3,     label: 'h.' },
  { beats: 2,     label: 'h'  }, { beats: 1.5,   label: 'q.' },
  { beats: 1,     label: 'q'  }, { beats: 0.75,  label: 'e.' },
  { beats: 0.5,   label: 'e'  }, { beats: 0.375, label: 's.' },
  { beats: 0.25,  label: 's'  }, { beats: 0.125, label: 't'  },
];
function durLabel(beats) {
  let best = DURATION_LABELS[0], bestDist = Infinity;
  for (const d of DURATION_LABELS) {
    const dist = Math.abs(Math.log2(beats / d.beats));
    if (dist < bestDist) { best = d; bestDist = dist; }
  }
  return best.label;
}

// Pick the best string + fret for a MIDI note, preferring candidates whose
// fret is at or above the neck position (and closest to it). Exported so the
// fretboard can highlight the SAME string/fret the tab shows.
function pickStringFret(midi, neckPos) {
  if (midi == null) return null;
  const cands = [];
  for (let s = 0; s < GUITAR_OPEN_MIDI.length; s++) {
    const fret = midi - GUITAR_OPEN_MIDI[s];
    if (fret >= 0 && fret <= 22) cands.push({ s, fret });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => {
    const da = a.fret < neckPos ? (neckPos - a.fret) + 24 : (a.fret - neckPos);
    const db = b.fret < neckPos ? (neckPos - b.fret) + 24 : (b.fret - neckPos);
    return da - db;
  });
  return cands[0];
}

function TabStaff({ items, idx, neckPos }) {
  const [svgRef, { w }] = useSize();
  const VISIBLE = 8;
  const slice = items.slice(idx, idx + VISIBLE);
  const nStr = GUITAR_OPEN_MIDI.length;
  const PADL = 32, PADR = 14, PADT = 10, PADB = 28;
  const STR_SP = 14;
  const innerH = STR_SP * (nStr - 1);
  const H = innerH + PADT + PADB;
  const drawW = Math.max((w || 0) - PADL - PADR, 1);

  const durations = slice.map(it => Math.max(it.duration ?? 1, 0.0625));
  const totalDur = durations.reduce((a, b) => a + b, 0) || 1;
  const colWs = durations.map(d => (d / totalDur) * drawW);
  const colXs = [];
  { let cum = PADL; for (const cw of colWs) { colXs.push(cum); cum += cw; } }

  // Mirror the fretboard's auto-position so the tab and the fretboard agree
  // on which fret each note lands at. When the user explicitly moves the
  // neck (neckPos > 0) that overrides the auto choice.
  const { root: keyRoot, mode: keyMode } = detectKey(items);
  const scaleIvs = keyMode === 'major' ? SCALE_MAJOR : PENTA_MINOR;
  const scalePCs = new Set(scaleIvs.map(iv => (keyRoot + iv) % 12));
  const upcoming = items.slice(idx, idx + 16);
  const autoPos = bestNeckPos(upcoming.length ? upcoming : items, scalePCs);
  const effectivePos = (neckPos === 0 && autoPos > 0) ? autoPos : neckPos;

  const positions = slice.map(it => pickStringFret(noteToMidi(it.note), effectivePos));

  return (
    <div style={{ flexShrink: 0, background: '#0d0d0d', borderRadius: 6, padding: '6px 0' }}>
      <div style={{ color: '#666', fontSize: 9, textTransform: 'uppercase', letterSpacing: 1, padding: '0 12px', marginBottom: 2 }}
           title="column width = duration · w/h/q/e/s = whole/half/quarter/eighth/sixteenth">
        Tab · next {slice.length}
      </div>
      <div ref={svgRef} style={{ width: '100%', height: H, position: 'relative' }}>
        <svg width={w || 0} height={H} style={{ display: 'block' }}>
          {w > 0 && (
            <>
              {GUITAR_STRING_LABELS.map((lbl, s) => (
                <text key={'l' + s} x={PADL - 8} y={PADT + s * STR_SP + 4}
                      textAnchor="end" fill="#666" fontSize={10} fontFamily="monospace">{lbl}</text>
              ))}
              {GUITAR_STRING_LABELS.map((_, s) => (
                <line key={'s' + s} x1={PADL} x2={PADL + drawW}
                      y1={PADT + s * STR_SP} y2={PADT + s * STR_SP}
                      stroke="#333" strokeWidth={0.8} />
              ))}
              {/* column boundary ticks */}
              {colXs.map((x, i) => i > 0 && (
                <line key={'b' + i} x1={x} x2={x} y1={PADT - 2} y2={PADT + innerH + 2}
                      stroke="#222" strokeWidth={0.5} strokeDasharray="2 2" />
              ))}
              {/* current-note highlight */}
              <rect x={colXs[0]} y={PADT - 4} width={colWs[0]}
                    height={innerH + 8} fill="#ffb34715" rx={3} />
              {positions.map((p, i) => {
                const cx = colXs[i] + colWs[i] / 2;
                if (!p) {
                  return <text key={'n' + i} x={cx} y={PADT + innerH / 2 + 4}
                               textAnchor="middle" fill="#444" fontSize={10}>—</text>;
                }
                const cy = PADT + p.s * STR_SP + 4;
                const isCur = i === 0;
                const sustainEnd = colXs[i] + colWs[i] - 4;
                const sustainStart = cx + 10;
                return (
                  <g key={'n' + i}>
                    {sustainEnd > sustainStart && (
                      <line x1={sustainStart} x2={sustainEnd} y1={cy - 4} y2={cy - 4}
                            stroke={isCur ? '#ffb34770' : '#555'} strokeWidth={1.4}
                            strokeDasharray="3 2" />
                    )}
                    <rect x={cx - 9} y={cy - 9} width={18} height={13}
                          fill="#0d0d0d" rx={2} />
                    <text x={cx} y={cy} textAnchor="middle"
                          fill={isCur ? '#ffb347' : '#bbb'}
                          fontSize={isCur ? 12 : 11}
                          fontWeight={isCur ? 700 : 400}
                          fontFamily="monospace">{p.fret}</text>
                  </g>
                );
              })}
              {/* duration label */}
              {slice.map((it, i) => {
                const cx = colXs[i] + colWs[i] / 2;
                return <text key={'d' + i} x={cx} y={PADT + innerH + 11}
                             textAnchor="middle" fill={i === 0 ? '#ffb347' : '#777'}
                             fontSize={9} fontFamily="monospace" fontWeight={i === 0 ? 700 : 400}>
                  {durLabel(it.duration ?? 1)}
                </text>;
              })}
              {/* lyric labels under tab — clipped to column to prevent overlap */}
              {slice.map((it, i) => {
                const CHAR_W = 5.4; // monospace 9px
                const PAD = 3;
                const available = colWs[i] - PAD * 2;
                const maxChars = Math.floor(available / CHAR_W);
                if (maxChars < 1) return null;
                const raw = it.lyric || it.note || '';
                if (!raw) return null;
                const word = raw.length > maxChars
                  ? (maxChars >= 2 ? raw.slice(0, maxChars - 1) + '…' : raw.slice(0, 1))
                  : raw;
                const cx = colXs[i] + colWs[i] / 2;
                return <text key={'w' + i} x={cx} y={PADT + innerH + 22}
                             textAnchor="middle" fill={i === 0 ? '#ffb347' : '#555'}
                             fontSize={9} fontFamily="monospace">{word}</text>;
              })}
            </>
          )}
        </svg>
      </div>
    </div>
  );
}

function GuitarFretboard({ items, idx, neckPos, onNeckPos }) {
  const [svgRef, { w, h }] = useSize();
  const NUM_FRETS = 5;

  const { root: keyRoot, mode: keyMode } = detectKey(items);
  const useFlatsForKey = usesFlats(keyRoot, keyMode);
  const scaleIvs = keyMode === 'major' ? SCALE_MAJOR : PENTA_MINOR;
  const scalePCs = new Set(scaleIvs.map(iv => (keyRoot + iv) % 12));

  // Auto-position: pick the box that covers the upcoming ~16 notes weighted
  // by frequency. As idx advances, the box re-targets the next phrase.
  const upcoming = items.slice(idx, idx + 16);
  const autoPos = bestNeckPos(upcoming.length ? upcoming : items, scalePCs);
  const effectivePos = (neckPos === 0 && autoPos > 0) ? autoPos : neckPos;

  // Specific string+fret for the current and next note — same picker the tab
  // uses, so the highlight on the fretboard matches the fret number in the tab.
  const curPos = pickStringFret(noteToMidi(items[idx]?.note), effectivePos);
  const nextPos = items[idx + 1]
    ? pickStringFret(noteToMidi(items[idx + 1].note), effectivePos)
    : null;

  const PL = 32, PR = 10, PT = 20, PB = 16;
  const drawW = Math.max((w || 0) - PL - PR, 1);
  const drawH = Math.max((h || 0) - PT - PB, 1);
  const nStr = GUITAR_OPEN_MIDI.length;
  const strSp = drawH / (nStr - 1);
  const fretSp = drawW / NUM_FRETS;
  const dotR = Math.max(1, Math.min(strSp / 2 - 2, 16));

  const dots = [];
  if (w > 0 && h > 0) {
    for (let s = 0; s < nStr; s++) {
      const minF = effectivePos === 0 ? 0 : effectivePos + 1;
      for (let f = minF; f <= effectivePos + NUM_FRETS; f++) {
        const midi = GUITAR_OPEN_MIDI[s] + f;
        const pc = ((midi % 12) + 12) % 12;
        if (!scalePCs.has(pc)) continue;
        const isOpen = f === 0;
        const cx = isOpen ? PL - 14 : PL + (f - effectivePos - 0.5) * fretSp;
        const cy = PT + s * strSp;
        const isRoot = pc === keyRoot;
        const isCur = curPos && curPos.s === s && curPos.fret === f;
        const isNext = !isCur && nextPos && nextPos.s === s && nextPos.fret === f;
        dots.push({ cx, cy, pc, isRoot, isCur, isNext, noteName: pcName(pc, useFlatsForKey) });
      }
    }
  }

  const keyName = pcName(keyRoot, useFlatsForKey) + (keyMode === 'major' ? ' maj' : ' min');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '4px 0', flexShrink: 0 }}>
        <span style={{ color: '#666', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>
          {keyName} · {effectivePos === 0 ? 'Open' : `Fret ${effectivePos + 1}`}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={() => onNeckPos(Math.max(0, neckPos - 1))}
            style={{ background: '#1a1a1a', border: '1px solid #333', color: '#888',
                     borderRadius: 4, padding: '2px 10px', fontSize: 13, cursor: 'pointer' }}>↑</button>
          <button onClick={() => onNeckPos(Math.min(12, neckPos + 1))}
            style={{ background: '#1a1a1a', border: '1px solid #333', color: '#888',
                     borderRadius: 4, padding: '2px 10px', fontSize: 13, cursor: 'pointer' }}>↓</button>
        </div>
      </div>
      <div ref={svgRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <svg viewBox={w > 0 && h > 0 ? `0 0 ${w} ${h}` : '0 0 1 1'}
             preserveAspectRatio="none"
             style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                      display: 'block', background: '#0d0d0d', borderRadius: 6 }}>
          {w > 0 && h > 0 && (
            <>
              {effectivePos === 0 && <rect x={PL - 1} y={PT} width={3} height={drawH} fill="#777" />}
              {Array.from({ length: NUM_FRETS + 1 }, (_, i) => (
                <line key={i} x1={PL + i * fretSp} x2={PL + i * fretSp}
                      y1={PT} y2={PT + drawH} stroke="#2a2a2a" strokeWidth={1} />
              ))}
              {GUITAR_OPEN_MIDI.map((_, s) => (
                <line key={s} x1={effectivePos === 0 ? PL - 1 : PL} x2={PL + drawW}
                      y1={PT + s * strSp} y2={PT + s * strSp}
                      stroke="#3a3a3a" strokeWidth={0.6 + (nStr - 1 - s) * 0.22} />
              ))}
              {GUITAR_STRING_LABELS.map((lbl, s) => (
                <text key={s} x={effectivePos === 0 ? PL - 18 : PL - 8} y={PT + s * strSp + 4}
                      textAnchor="middle" fill="#555" fontSize={10} fontFamily="monospace">{lbl}</text>
              ))}
              {Array.from({ length: NUM_FRETS }, (_, i) => {
                const fn = effectivePos + i + 1;
                const x = PL + (i + 0.5) * fretSp;
                const isMarker = [3,5,7,9,12,15,17,19,21].includes(fn);
                return (
                  <g key={i}>
                    <text x={x} y={PT - 4} textAnchor="middle"
                          fill={isMarker ? '#666' : '#333'} fontSize={9} fontFamily="sans-serif">{fn}</text>
                    {isMarker && <circle cx={x} cy={PT + drawH + 8} r={3} fill="#333" />}
                  </g>
                );
              })}
              {dots.map((d, i) => {
                const fill = d.isCur ? '#ffb347' : d.isNext ? '#3a2a14' : '#1a1a1a';
                const stroke = d.isCur ? '#ff9800' : d.isNext ? '#8a6a30' : d.isRoot ? '#555' : '#2a2a2a';
                const textFill = d.isCur ? '#000' : d.isNext ? '#d4a050' : '#555';
                const sw = (d.isRoot && !d.isCur) ? 1.5 : 2;
                return (
                  <g key={i}>
                    <circle cx={d.cx} cy={d.cy} r={dotR} fill={fill} stroke={stroke} strokeWidth={sw} />
                    <text x={d.cx} y={d.cy + 4} textAnchor="middle"
                          fill={textFill} fontSize={Math.max(dotR - 3, 7)} fontFamily="monospace" fontWeight="bold">
                      {d.noteName}
                    </text>
                  </g>
                );
              })}
            </>
          )}
        </svg>
      </div>
    </div>
  );
}

// ── Main App ─────────────────────────────────────────────────────────
export default function App() {
  const [phase, setPhase]       = useState('upload'); // upload | setup | practice
  const [lyrics, setLyrics]     = useState([]);
  const [pdfPages, setPdfPages] = useState([]);       // rendered page image URLs
  const [musicXml, setMusicXml] = useState(null);     // MusicXML string for OSMD sheet renderer
  const [items, setItems]       = useState([]);       // [{note, lyric, status}]
  const [idx, setIdx]           = useState(0);
  const [isListening, setIsListening] = useState(false);
  const [micLabel, setMicLabel] = useState('');
  const micBarRef    = useRef(null); // mic level bar DOM element
  const pitchCanvasRef = useRef(null); // canvas overlay for pitch line
  const centsBarRef  = useRef(null); // cents display container
  const centsTextRef = useRef(null); // cents display text span
  const freqTextRef  = useRef(null); // "E4 (329 Hz)" text in controls
  const [statusMsg, setStatusMsg] = useState('');
  const [pdfLoading, setPdfLoading] = useState(false);
  const [octaveShift, setOctaveShift] = useState(0); // semitones shift in multiples of 12
  const [tolerance, setTolerance] = useState(50);   // cents threshold for green
  const toleranceRef = useRef(50);
  const [bpm, setBpm] = useState(120);
  const bpmRef = useRef(120);
  const [autoPlay, setAutoPlay] = useState(false);
  const autoPlayRef = useRef(false);
  const [holdMode, setHoldMode] = useState(false);
  const holdModeRef = useRef(false);
  const HOLD_MIN_MS = 500;
  const holdStartRef = useRef(null);
  const ADVANCE_PAUSE_MS = 250;
  const pendingAdvanceRef = useRef(null); // { at, lyricIdx } — scheduled advance time
  const [calOctave, setCalOctave] = useState(4);
  const calOctaveRef = useRef(4);
  const [chartText, setChartText] = useState('');
  const [chartWarning, setChartWarning] = useState('');
  const [chartSections, setChartSections] = useState([]);
  const [savedSongs, setSavedSongs] = useState({});
  const [neckPos, setNeckPos] = useState(0);

  useEffect(() => {
    fetchSavedSongs().then(setSavedSongs);
  }, []);

  // refs to avoid stale closures in rAF loop
  const listeningRef  = useRef(false);
  const idxRef        = useRef(0);
  const itemsRef      = useRef([]);
  const audioCtxRef   = useRef(null);
  const analyserRef   = useRef(null);
  const streamRef     = useRef(null);
  const bufRef        = useRef(null);
  const holdTimerRef    = useRef(null); // timestamp when hold started
  const rafRef          = useRef(null);
  const prefillRef      = useRef(null); // pre-filled {note,lyric}[] from backend
  const smoothedFreqRef = useRef(null); // slow EMA — draws pitch line on canvas
  const fastFreqRef     = useRef(null); // fast EMA — hold detection
  const calCanvasRef    = useRef(null); // calibrate page canvas
  const calRafRef       = useRef(null); // calibrate page RAF handle
  const calSmoothRef    = useRef(null); // calibrate page EMA
  const statusStreakRef = useRef({ status: null, count: 0, committed: null });
  const canvasFrameRef  = useRef(0); // throttle canvas redraws to 10fps
  const playbackCtxRef  = useRef(null);
  const autoPlayTimersRef = useRef([]);

  const octaveShiftRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => { octaveShiftRef.current = octaveShift; }, [octaveShift]);
  useEffect(() => { toleranceRef.current = tolerance; }, [tolerance]);
  useEffect(() => { bpmRef.current = bpm; }, [bpm]);
  useEffect(() => { autoPlayRef.current = autoPlay; }, [autoPlay]);
  useEffect(() => { holdModeRef.current = holdMode; if (!holdMode) holdStartRef.current = null; }, [holdMode]);
  useEffect(() => { calOctaveRef.current = calOctave; }, [calOctave]);
  useEffect(() => {
    if (chartText.trim()) setChartSections(parseChordChart(chartText));
    else setChartSections([]);
  }, [chartText]);

  // Auto-advance each note based on BPM timing when autoPlay is on
  useEffect(() => {
    if (!autoPlay || phase !== 'practice' || idx >= items.length) return;
    const noteSec = (items[idx]?.duration ?? 1) / bpm * 60;
    const timer = setTimeout(() => {
      statusStreakRef.current = { status: null, count: 0, committed: null, greenCount: 0 };
      const next = idx + 1;
      setIdx(next);
      idxRef.current = next;
      if (next >= itemsRef.current.length) {
        setStatusMsg('🎉 Song complete!');
        setAutoPlay(false);
      }
    }, noteSec * 1000);
    return () => clearTimeout(timer);
  }, [autoPlay, idx, phase, items, bpm]);

  // ── Audio playback (note preview) ──────────────────────────────────
  const stopPlayback = useCallback(() => {
    if (playbackCtxRef.current) {
      playbackCtxRef.current.close();
      playbackCtxRef.current = null;
    }
    autoPlayTimersRef.current.forEach(clearTimeout);
    autoPlayTimersRef.current = [];
    setIsPlaying(false);
  }, []);

  const scheduleNote = (ctx, freq, startTime, durationSec) => {
    if (!freq) return;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    // Two oscillators for a rounder tone: fundamental + soft octave up
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc2.connect(gain2); gain2.connect(ctx.destination);
    osc.type = 'sine'; osc.frequency.value = freq;
    osc2.type = 'sine'; osc2.frequency.value = freq * 2;
    const t = startTime, end = t + durationSec;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.35, t + 0.03);
    gain.gain.setValueAtTime(0.35, end - 0.06);
    gain.gain.linearRampToValueAtTime(0, end);
    gain2.gain.setValueAtTime(0, t);
    gain2.gain.linearRampToValueAtTime(0.08, t + 0.03);
    gain2.gain.linearRampToValueAtTime(0, end);
    osc.start(t); osc.stop(end + 0.05);
    osc2.start(t); osc2.stop(end + 0.05);
  };

  const playNoteAudio = useCallback(() => {
    stopPlayback();
    const curIdx = idxRef.current;
    const curItems = itemsRef.current;
    if (curIdx >= curItems.length) return;
    const freq = noteToFreq(shiftNote(curItems[curIdx].note, octaveShiftRef.current * 12));
    if (!freq) return;
    const dur = (curItems[curIdx].duration ?? 1) / bpmRef.current * 60;
    const ctx = new AudioContext();
    playbackCtxRef.current = ctx;
    setIsPlaying(true);
    scheduleNote(ctx, freq, ctx.currentTime, Math.max(0.4, dur));
    setTimeout(() => { ctx.close(); playbackCtxRef.current = null; setIsPlaying(false); },
      (Math.max(0.4, dur) + 0.3) * 1000);
  }, [stopPlayback]);

  const playPhraseAudio = useCallback(() => {
    stopPlayback();
    const curIdx = idxRef.current;
    const curItems = itemsRef.current;
    if (curIdx >= curItems.length) return;
    const semitones = octaveShiftRef.current * 12;
    const ctx = new AudioContext();
    playbackCtxRef.current = ctx;
    setIsPlaying(true);
    let time = ctx.currentTime + 0.05;
    let totalDur = 0;
    const slice = curItems.slice(curIdx, curIdx + 8);
    for (const item of slice) {
      const freq = noteToFreq(shiftNote(item.note, semitones));
      const dur  = (item.duration ?? 1) / bpmRef.current * 60;
      scheduleNote(ctx, freq, time, dur);
      time += dur;
      totalDur += dur;
    }
    setTimeout(() => { ctx.close(); playbackCtxRef.current = null; setIsPlaying(false); },
      (totalDur + 0.4) * 1000);
  }, [stopPlayback]);

  // Auto-play: walk through every remaining note, playing each one and advancing
  // the highlighted note index in sync so the user can follow along visually.
  const playAutoAll = useCallback(() => {
    stopPlayback();
    const curIdx = idxRef.current;
    const curItems = itemsRef.current;
    if (curIdx >= curItems.length) return;
    const semitones = octaveShiftRef.current * 12;
    const ctx = new AudioContext();
    playbackCtxRef.current = ctx;
    setIsPlaying(true);
    let timeOffsetSec = 0.05;
    for (let i = curIdx; i < curItems.length; i++) {
      const item = curItems[i];
      const freq = noteToFreq(shiftNote(item.note, semitones));
      const dur = (item.duration ?? 1) / bpmRef.current * 60;
      if (freq) scheduleNote(ctx, freq, ctx.currentTime + timeOffsetSec, dur);
      // Advance the highlighted index when this note begins to sound.
      const t = setTimeout(() => {
        setIdx(i);
        idxRef.current = i;
      }, timeOffsetSec * 1000);
      autoPlayTimersRef.current.push(t);
      timeOffsetSec += dur;
    }
    const endTimer = setTimeout(() => {
      ctx.close(); playbackCtxRef.current = null; setIsPlaying(false);
      autoPlayTimersRef.current = [];
    }, (timeOffsetSec + 0.4) * 1000);
    autoPlayTimersRef.current.push(endTimer);
  }, [stopPlayback]);

  const loadFromCache = async (song, file = null) => {
    setPdfLoading(true);
    setStatusMsg('Loading from cache…');
    try {
      if (file) {
        const [pages, chordPairs] = await Promise.all([
          renderPdfPages(file),
          extractChordChartFromPdf(file),
        ]);
        setPdfPages(pages);
        const hasPairs = chordPairs.some(p => p.type === 'pair');
        const allNotes = hasPairs
          ? assignLyricsFromChordPairs(song.notes, chordPairs, song.systemBreaks)
          : song.notes;
        // Focus on sung notes only — drop instrumental intros / interludes / outros
        // that have no lyric attached. Chord chart still renders from chordPairs.
        const finalNotes = hasPairs ? allNotes.filter(n => n.lyric) : allNotes;
        if (song.bpm) setBpm(song.bpm);
        if (song.hasMusicXml) fetchMusicXml(song.filename).then(setMusicXml);
        else setMusicXml(null);
        dbg('loadFromCache.path', {
          filename: song.filename, hasPairs, systemBreaks: song.systemBreaks, bpm: song.bpm,
          totalNotes: allNotes.length, sungNotes: finalNotes.length,
          firstNotes: finalNotes.slice(0, 20).map(n => ({ note: n.note, lyric: n.lyric, measure: n.measure })),
        });
        setLyrics(finalNotes.map(n => n.lyric));
        prefillRef.current = finalNotes;
        const chart = hasPairs ? buildChordChartText(chordPairs, finalNotes) : '';
        setChartText(chart);
        if (chart) saveChartToCache(song.filename, chart);
        if (!chart) {
          setChartWarning(chordPairs.hasText
            ? 'No chord chart found in PDF text. Click Edit to paste one manually.'
            : 'This PDF has no text layer (image-only) — chord chart can\'t be extracted. Click Edit to paste one manually.');
        } else setChartWarning('');
      } else {
        setPdfPages([]);
        setLyrics(song.notes.map(n => n.lyric));
        prefillRef.current = song.notes;
        setChartText(song.chartText || '');
      }
      setStatusMsg('');
      setPhase('setup');
    } catch (err) {
      setStatusMsg('Error loading song: ' + err.message);
    }
    setPdfLoading(false);
  };

  const handlePdf = async e => {
    const file = e.target.files[0];
    if (!file) return;
    setPdfLoading(true);
    setStatusMsg('Reading PDF…');
    try {
      // Check server cache by filename first
      const cached = savedSongs[file.name];
      if (cached) {
        await loadFromCache(cached, file);
        return;
      }

      // Render pages for visual reference + extract lyrics from text layer
      const [extracted, pages] = await Promise.all([
        extractLyricsFromPdf(file),
        renderPdfPages(file),
      ]);
      setPdfPages(pages);

      // Try to auto-extract notes via the local Audiveris backend
      setStatusMsg('Running OMR — extracting notes automatically (this takes ~1–2 min)…');
      let omrError = null;
      try {
        const form = new FormData();
        form.append('pdf', file);
        const res  = await fetch('http://localhost:5001/extract', { method: 'POST', body: form });
        const data = await res.json();
        if (res.ok && data.notes && data.notes.length > 0) {
          fetchSavedSongs().then(setSavedSongs);
          const chordPairs = await extractChordChartFromPdf(file);
          const hasPairs = chordPairs.some(p => p.type === 'pair');
          const allNotes = hasPairs
            ? assignLyricsFromChordPairs(data.notes, chordPairs, data.systemBreaks)
            : data.notes;
          // Focus on sung notes only — drop instrumental intros / interludes / outros.
          const finalNotes = hasPairs ? allNotes.filter(n => n.lyric) : allNotes;
          if (data.bpm) setBpm(data.bpm);
          // Audiveris ran (or cache hit): fetch the cached MusicXML for OSMD render.
          fetchMusicXml(file.name).then(setMusicXml);
          dbg('freshUpload.path', {
            filename: file.name, hasPairs, systemBreaks: data.systemBreaks, bpm: data.bpm,
            totalNotes: allNotes.length, sungNotes: finalNotes.length,
            firstNotes: finalNotes.slice(0, 20).map(n => ({ note: n.note, lyric: n.lyric, measure: n.measure })),
          });
          setLyrics(finalNotes.map(n => n.lyric));
          const chart = hasPairs ? buildChordChartText(chordPairs, finalNotes) : '';
          setChartText(chart);
          if (chart) saveChartToCache(file.name, chart);
          if (!chart) {
            setChartWarning(chordPairs.hasText
              ? 'No chord chart found in PDF text. Click Edit to paste one manually.'
              : 'This PDF has no text layer (image-only) — chord chart can\'t be extracted. Click Edit to paste one manually.');
          } else setChartWarning('');
          setStatusMsg('');
          setPhase('setup');
          prefillRef.current = finalNotes;
          setPdfLoading(false);
          return;
        }
        omrError = data.error || `Server returned ${res.status}`;
      } catch (err) {
        omrError = err.message;
      }

      // Backend failed — use text-extracted lyrics only, manual notes
      setLyrics(extracted);
      setStatusMsg('');
      prefillRef.current = null;
      prefillRef.errorMsg = omrError;
      setPhase('setup');
    } catch (err) {
      setStatusMsg('PDF read error: ' + err.message);
    }
    setPdfLoading(false);
  };

  const handleStart = useCallback(rows => {
    let it = rows.map(r => ({ note: r.note.trim(), lyric: r.lyric.trim(), status: null, duration: r.duration, measure: r.measure, beat: r.beat }));
    if (chartSections.length) it = enrichNotesWithChart(it, chartSections);
    it = addDirectionHints(it); // auto-fill any missing direction hints from pitch sequence
    setItems(it);
    itemsRef.current = it;
    setIdx(0);
    idxRef.current = 0;
    setPhase('practice');
  }, [chartSections]);

  // ── pitch loop ──────────────────────────────────────────────────────
  const pitchLoop = useCallback(() => {
    if (!listeningRef.current || !analyserRef.current) return;

    analyserRef.current.getFloatTimeDomainData(bufRef.current);

    let rms = 0;
    for (let i = 0; i < bufRef.current.length; i++) rms += bufRef.current[i] ** 2;
    if (micBarRef.current)
      micBarRef.current.style.width = `${Math.min(Math.sqrt(rms / bufRef.current.length) * 600, 100)}%`;

    const sampleRate = audioCtxRef.current.sampleRate;
    const rawFreq = detectPitch(bufRef.current, sampleRate);

    const applyEMA = (ref, alpha, raw) => {
      if (!raw) { ref.current = null; return; }
      const prev = ref.current;
      if (prev) {
        const ratio = raw / prev;
        if (ratio >= 0.45 && ratio <= 2.2) ref.current = alpha * raw + (1 - alpha) * prev;
      } else {
        ref.current = raw;
      }
    };
    applyEMA(smoothedFreqRef, 0.08, rawFreq);
    applyEMA(fastFreqRef, 0.35, rawFreq);

    // Throttle display + detection to 4 times per second (every 15 frames at 60fps)
    canvasFrameRef.current = (canvasFrameRef.current + 1) % 15;
    if (canvasFrameRef.current !== 0) {
      rafRef.current = requestAnimationFrame(pitchLoop);
      return;
    }

    const displayFreq = smoothedFreqRef.current;
    const detectFreq  = fastFreqRef.current;

    // Draw pitch line on canvas
    const canvas = pitchCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, ML_W, ML_H);
      const curIdxNow = idxRef.current;
      const curItemsNow = itemsRef.current;
      if (displayFreq && curIdxNow < curItemsNow.length) {
        // Recompute MelodyLine coordinate system
        const mlStart = Math.max(0, curIdxNow - ML_BEFORE);
        const mlEnd   = Math.min(curItemsNow.length, mlStart + ML_VISIBLE);
        const visible = curItemsNow.slice(mlStart, mlEnd);
        const layout  = computeLayout(visible);
        const curVis  = curIdxNow - mlStart;
        const semitones = octaveShiftRef.current * 12;
        const midis   = visible.map(it => noteToMidi(shiftNote(it.note, semitones))).filter(Boolean);
        const minM    = Math.min(...midis) - 2;
        const maxM    = Math.max(...midis) + 2;
        const range   = Math.max(maxM - minM, 4);
        const midiToY = m => ML_H - ML_PAD_V - ((m - minM) / range) * (ML_H - ML_PAD_V * 2);

        const sungMidi = freqToMidi(displayFreq);
        const sungY = Math.max(4, Math.min(ML_H - 4, midiToY(sungMidi)));
        const { cx, w: noteW } = layout[curVis] ?? { cx: ML_W / 2, w: 40 };
        const committed = statusStreakRef.current.committed;
        const color = committed
          ? ({ green: '#4caf50', yellow: '#ffeb3b', red: '#f44336' }[committed] ?? '#ff6b35')
          : '#ff6b35';

        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3;
        ctx.setLineDash([6, 3]);
        ctx.beginPath();
        ctx.moveTo(cx - noteW / 2 + 6, sungY);
        ctx.lineTo(cx + noteW / 2 - 6, sungY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(cx, sungY, 5, 0, Math.PI * 2); ctx.fill();
        ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
        ctx.fillText(freqToName(displayFreq), cx + noteW / 2 - 4, sungY - 5);
      }
    }

    let curIdx = idxRef.current;
    const curItems = itemsRef.current;

    // Auto-skip items with no lyric
    while (curIdx < curItems.length && !curItems[curIdx].lyric) {
      curIdx++;
      setIdx(curIdx);
      idxRef.current = curIdx;
    }

    if (detectFreq && curItems.length > 0 && curIdx < curItems.length) {
      const targetFreq = noteToFreq(shiftNote(curItems[curIdx].note, octaveShiftRef.current * 12));
      if (targetFreq) {
        const absCents = Math.abs(centsDiff(targetFreq, detectFreq));
        // Semitone-based thresholds: green = on note, yellow = within 2 semitones, red = further
        const rawStatus = absCents <= toleranceRef.current ? 'green' : absCents <= 200 ? 'yellow' : 'red';

        const streak = statusStreakRef.current;
        if (rawStatus === 'green') streak.greenCount = (streak.greenCount ?? 0) + 1;
        else streak.greenCount = 0;
        streak.committed = rawStatus;
        const committedStatus = rawStatus;

        // Update cents bar
        const STATUS_BG = { green: '#1a3a1a', yellow: '#2a2a0a', red: '#3a0a0a' };
        const STATUS_FG = { green: '#4caf50', yellow: '#ffeb3b', red: '#f44336' };
        if (centsBarRef.current)
          centsBarRef.current.style.background = STATUS_BG[committedStatus] ?? 'transparent';
        if (centsTextRef.current) {
          const c = centsDiff(targetFreq, detectFreq);
          const absC = Math.abs(c);
          let txt = committedStatus === 'green' ? '✓ On pitch'
            : `${committedStatus === 'yellow' ? '~' : ''}${Math.round(absC)}¢ off`;
          if (c > 5) txt += '  (too high)'; else if (c < -5) txt += '  (too low)';
          centsTextRef.current.textContent = txt;
          centsTextRef.current.style.color = STATUS_FG[committedStatus];
          centsTextRef.current.style.display = '';
        }
        if (freqTextRef.current)
          freqTextRef.current.textContent = displayFreq ? ` | ${freqToName(displayFreq)} (${Math.round(displayFreq)} Hz)` : '';

        // Update lyric color
        if (committedStatus !== curItems[curIdx].status) {
          setItems(prev => prev.map((it, i) => i === curIdx ? { ...it, status: committedStatus } : it));
          itemsRef.current = itemsRef.current.map((it, i) => i === curIdx ? { ...it, status: committedStatus } : it);
        }

        // If we're already in the celebration pause, hold position and freeze cues.
        if (pendingAdvanceRef.current) {
          const { at } = pendingAdvanceRef.current;
          const now = performance.now();
          if (centsTextRef.current) {
            centsTextRef.current.textContent = '✓ Nice!';
            centsTextRef.current.style.color = '#4caf50';
          }
          if (centsBarRef.current) centsBarRef.current.style.background = '#1a3a1a';
          if (now >= at) {
            const next = pendingAdvanceRef.current.next;
            pendingAdvanceRef.current = null;
            statusStreakRef.current = { status: null, count: 0, committed: null, greenCount: 0 };
            holdStartRef.current = null;
            setIdx(next);
            idxRef.current = next;
            if (next >= curItems.length) setStatusMsg('🎉 Song complete!');
          }
          rafRef.current = requestAnimationFrame(pitchLoop);
          return;
        }

        const scheduleAdvance = () => {
          pendingAdvanceRef.current = { at: performance.now() + ADVANCE_PAUSE_MS, next: curIdx + 1 };
        };

        // Advance logic
        if (!autoPlayRef.current) {
          if (holdModeRef.current) {
            // Hold mode: must sustain green for max(1s, notated note duration)
            const noteSec = (curItems[curIdx].duration ?? 1) / bpmRef.current * 60;
            const requiredMs = Math.max(HOLD_MIN_MS, noteSec * 1000);
            if (committedStatus === 'green') {
              const now = performance.now();
              if (holdStartRef.current == null) holdStartRef.current = now;
              const heldMs = now - holdStartRef.current;
              if (centsTextRef.current) {
                const sec = (heldMs / 1000).toFixed(1);
                const target = (requiredMs / 1000).toFixed(1);
                centsTextRef.current.textContent = `✓ Hold ${sec}s / ${target}s`;
              }
              if (heldMs >= requiredMs) scheduleAdvance();
            } else {
              holdStartRef.current = null;
            }
          } else {
            const noteSec = (curItems[curIdx].duration ?? 1) / bpmRef.current * 60;
            const tickSec = 15 / 60;
            const ticksNeeded = Math.max(1, Math.round(noteSec * 0.8 / tickSec));
            if (committedStatus === 'green' && streak.greenCount >= ticksNeeded) scheduleAdvance();
          }
        }
      }
    } else if (!detectFreq) {
      holdTimerRef.current = null;
    }

    rafRef.current = requestAnimationFrame(pitchLoop);
  }, []);

  const startListening = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const an  = ctx.createAnalyser();
      an.fftSize = 4096;
      bufRef.current = new Float32Array(an.frequencyBinCount);
      src.connect(an);
      analyserRef.current = an;
      listeningRef.current = true;
      setIsListening(true);
      setStatusMsg('Listening…');
      rafRef.current = requestAnimationFrame(pitchLoop);
    } catch (err) {
      setStatusMsg('Mic error: ' + err.message);
    }
  }, [pitchLoop]);

  const stopListening = useCallback(() => {
    listeningRef.current = false;
    setIsListening(false);
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    audioCtxRef.current?.close();
    streamRef.current = null;
    audioCtxRef.current = null;
    analyserRef.current = null;
    setStatusMsg('Stopped.');
    smoothedFreqRef.current = null;
    fastFreqRef.current = null;
    statusStreakRef.current = { status: null, count: 0, committed: null };
    const canvas = pitchCanvasRef.current;
    if (canvas) canvas.getContext('2d').clearRect(0, 0, 480, 200);
    if (centsBarRef.current) centsBarRef.current.style.background = 'transparent';
    if (centsTextRef.current) centsTextRef.current.style.display = 'none';
    if (freqTextRef.current) freqTextRef.current.textContent = '';
  }, []);

  const resetPractice = () => {
    setAutoPlay(false);
    autoPlayRef.current = false;
    setHoldMode(false);
    holdModeRef.current = false;
    holdStartRef.current = null;
    pendingAdvanceRef.current = null;
    stopListening();
    setItems(it => it.map(i => ({ ...i, status: null })));
    setIdx(0);
    idxRef.current = 0;
    holdTimerRef.current = null;
    setStatusMsg('');
  };

  const advanceManual = () => {
    holdTimerRef.current = null;
    setIdx(i => {
      const next = Math.min(i + 1, items.length);
      idxRef.current = next;
      return next;
    });
  };

  // ── Calibrate loop ──────────────────────────────────────────────────
  const CAL_RANGE = 12; // ±6 semitones visible

  const calLoop = useCallback(() => {
    if (!analyserRef.current) return;
    analyserRef.current.getFloatTimeDomainData(bufRef.current);
    const raw = detectPitch(bufRef.current, audioCtxRef.current.sampleRate);
    if (raw) {
      const smoothed = calSmoothRef.current
        ? 0.2 * raw + 0.8 * calSmoothRef.current : raw;
      const nearestMidi = Math.round(freqToMidi(smoothed));
      calSmoothRef.current = midiToFreq(nearestMidi);
    } else {
      calSmoothRef.current = null;
    }

    const canvas = calCanvasRef.current;
    if (canvas) {
      const calNote = 'G' + calOctaveRef.current;
      const calMidi = noteToMidi(calNote);
      const calNotes = Array.from({ length: CAL_RANGE + 1 }, (_, i) => calMidi - CAL_RANGE / 2 + i);

      const W = canvas.width, H = canvas.height, PAD = 40;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H);

      const midiToY = m => H - PAD - ((m - (calMidi - CAL_RANGE / 2)) / CAL_RANGE) * (H - PAD * 2);

      // Draw semitone grid lines + labels
      calNotes.forEach(m => {
        const y = midiToY(m);
        const isTarget = m === calMidi;
        ctx.strokeStyle = isTarget ? '#4a9eff44' : '#ffffff11';
        ctx.lineWidth = isTarget ? 2 : 1;
        ctx.beginPath(); ctx.moveTo(60, y); ctx.lineTo(W, y); ctx.stroke();
        const noteName = CHROMATIC[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
        ctx.fillStyle = isTarget ? '#4a9eff' : '#555';
        ctx.font = isTarget ? 'bold 13px sans-serif' : '11px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(noteName, 54, y + 4);
      });

      // Draw target note label
      ctx.fillStyle = '#4a9eff';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`← ${calNote}`, 66, midiToY(calMidi) - 8);

      // Draw pitch line
      const freq = calSmoothRef.current;
      if (freq) {
        const sungMidi = freqToMidi(freq);
        const sungY = Math.max(4, Math.min(H - 4, midiToY(sungMidi)));
        const absCents = Math.abs(centsDiff(noteToFreq(calNote), freq));
        const color = absCents <= toleranceRef.current ? '#4caf50' : absCents <= 200 ? '#ffeb3b' : '#f44336';
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3;
        ctx.setLineDash([6, 3]);
        ctx.beginPath(); ctx.moveTo(60, sungY); ctx.lineTo(W - 10, sungY); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'left';
        ctx.fillText(`${freqToName(freq)}  ${Math.round(freq)} Hz`, 66, sungY - 8);
      }
    }

    calRafRef.current = requestAnimationFrame(calLoop);
  }, []);

  const startCalibrate = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 4096;
      bufRef.current = new Float32Array(an.frequencyBinCount);
      src.connect(an);
      analyserRef.current = an;
      setIsListening(true);
      setMicLabel(stream.getAudioTracks()[0]?.label || 'Unknown mic');
      calRafRef.current = requestAnimationFrame(calLoop);
    } catch (err) {
      setStatusMsg('Mic error: ' + err.message);
    }
  }, [calLoop]);

  const stopCalibrate = useCallback(() => {
    cancelAnimationFrame(calRafRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    audioCtxRef.current?.close();
    streamRef.current = null; audioCtxRef.current = null; analyserRef.current = null;
    calSmoothRef.current = null;
    setIsListening(false);
    const canvas = calCanvasRef.current;
    if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  // ── Render ──────────────────────────────────────────────────────────
  const S = {
    app: { minHeight: '100vh', padding: '12px 14px', display: 'flex',
           flexDirection: 'column', alignItems: 'center' },
    card: { width: '100%', maxWidth: 680, background: '#161616',
            borderRadius: 10, padding: '10px 14px', marginBottom: 8 },
    btn: (color = '#4a9eff', disabled = false) => ({
      background: disabled ? '#1a1a1a' : color, color: disabled ? '#444' : '#000',
      border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 13,
      fontWeight: 'bold', cursor: disabled ? 'default' : 'pointer',
    }),
    h1: { fontSize: 18, fontWeight: 'bold', color: '#4a9eff', marginBottom: 0 },
  };

  if (phase === 'upload') {
    return (
      <div style={S.app}>
        <div style={S.card}>
          <h1 style={S.h1}>🎵 Singing Practice</h1>
          <p style={{ color: '#888', marginBottom: 24 }}>
            Upload a PDF with standard notation. Lyrics will be extracted automatically.
            You'll then add the note for each lyric word.
          </p>
          <label style={{ display: 'block', cursor: 'pointer' }}>
            <div style={{ border: '2px dashed #333', borderRadius: 10, padding: '32px 24px',
                          textAlign: 'center', color: '#555', transition: 'border-color 0.2s' }}
                 onDragOver={e => e.preventDefault()}>
              {pdfLoading ? 'Reading PDF…' : 'Click to upload or drag a PDF here'}
            </div>
            <input type="file" accept=".pdf" onChange={handlePdf}
                   style={{ display: 'none' }} disabled={pdfLoading} />
          </label>
          {statusMsg && <p style={{ color: pdfLoading ? '#4a9eff' : '#f44336', marginTop: 12 }}>{statusMsg}</p>}
          <p style={{ marginTop: 20, color: '#555', fontSize: 13, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            — or —
            <button onClick={() => { setLyrics([]); setPhase('setup'); }}
              style={{ background: 'none', border: 'none', color: '#4a9eff',
                       cursor: 'pointer', fontSize: 13 }}>
              Enter manually
            </button>
            <button onClick={() => setPhase('calibrate')}
              style={{ background: 'none', border: 'none', color: '#888',
                       cursor: 'pointer', fontSize: 13 }}>
              🎛 Calibrate / Test mic
            </button>
          </p>

        </div>

        {/* Recent songs */}
        {Object.keys(savedSongs).length > 0 && (
          <div style={S.card}>
            <div style={{ color: '#888', fontSize: 13, marginBottom: 12 }}>Recent songs</div>
            {Object.values(savedSongs)
              .sort((a, b) => b.savedAt - a.savedAt)
              .map(song => (
                <div key={song.filename} style={{ display: 'flex', alignItems: 'center',
                    gap: 10, padding: '10px 0', borderBottom: '1px solid #222' }}>
                  <button onClick={() => loadFromCache(song)}
                    style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none',
                             color: '#ddd', cursor: 'pointer', fontSize: 14, padding: 0 }}>
                    🎵 {song.filename}
                    <span style={{ color: '#555', fontSize: 11, marginLeft: 8 }}>
                      {song.notes.length} notes · {new Date(song.savedAt * 1000).toLocaleDateString()}
                    </span>
                  </button>
                  <button onClick={() => { deleteSong(song.filename).then(() => fetchSavedSongs().then(setSavedSongs)); }}
                    style={{ background: 'none', border: 'none', color: '#555',
                             cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>
                    ✕
                  </button>
                </div>
              ))}
          </div>
        )}
      </div>
    );
  }

  if (phase === 'setup') {
    return (
      <div style={{ minHeight: '100vh', background: '#0d0d0d', display: 'flex', gap: 0 }}>
        {/* Left: PDF pages + chart textarea */}
        <div style={{ width: '40%', display: 'flex', flexDirection: 'column',
                      background: '#1a1a1a', borderRight: '1px solid #2a2a2a' }}>
          {pdfPages.length > 0 && (
            <div style={{ flex: 1, overflowY: 'auto', padding: 16, borderBottom: '1px solid #2a2a2a' }}>
              <p style={{ color: '#555', fontSize: 12, marginBottom: 12 }}>Sheet music</p>
              {pdfPages.map((url, i) => (
                <img key={i} src={url} alt={`Page ${i + 1}`}
                     style={{ width: '100%', display: 'block', marginBottom: 12,
                              borderRadius: 4, border: '1px solid #2a2a2a' }} />
              ))}
            </div>
          )}
          {/* Chart textarea — auto-generated, editable to add sections */}
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column',
                        flex: pdfPages.length ? '0 0 auto' : 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ color: '#888', fontSize: 12 }}>
                Chart <span style={{ color: '#555' }}>— add [Section] headers to enable navigation</span>
              </span>
              {chartSections.length > 0 && (
                <span style={{ color: '#4caf50', fontSize: 11 }}>
                  ✓ {chartSections.length} sections
                </span>
              )}
            </div>
            <textarea
              value={chartText}
              onChange={e => setChartText(e.target.value)}
              placeholder={'[Verse 1]\n...\n\n[Chorus]\n...'}
              rows={pdfPages.length ? 12 : 30}
              style={{ background: '#0d0d0d', color: '#ccc', border: '1px solid #2a2a2a',
                       borderRadius: 8, padding: '10px 12px', fontSize: 11, fontFamily: 'monospace',
                       resize: 'vertical', width: '100%', boxSizing: 'border-box' }}
            />
          </div>
        </div>
        {/* Right: notes editor */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          <SetupEditor initialLyrics={lyrics} prefillRows={prefillRef.current} omrError={prefillRef.errorMsg} onStart={handleStart} />
        </div>
      </div>
    );
  }

  // ── Calibrate phase ─────────────────────────────────────────────────
  if (phase === 'calibrate') {
    return (
      <div style={S.app}>
        <div style={S.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h1 style={{ ...S.h1, marginBottom: 0 }}>🎛 Calibrate / Test Mic</h1>
            <button onClick={() => { stopCalibrate(); setPhase('upload'); }} style={S.btn('#333')}>← Back</button>
          </div>
          <p style={{ color: '#888', fontSize: 13, marginBottom: 16 }}>
            Sing <strong style={{ color: '#4a9eff' }}>G{calOctave}</strong> and watch the line move.
            Green = on pitch, yellow = within 2 semitones, red = further away.
          </p>
          <canvas ref={calCanvasRef} width={480} height={320}
                  style={{ display: 'block', margin: '0 auto', borderRadius: 12, background: '#111' }} />
          <div style={{ marginTop: 16, display: 'flex', gap: 12, justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap' }}>
            {!isListening
              ? <button onClick={startCalibrate} style={S.btn('#4a9eff')}>🎤 Start Mic</button>
              : <button onClick={stopCalibrate} style={S.btn('#f44336')}>⏹ Stop Mic</button>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: '#888', fontSize: 12 }}>Octave:</span>
              {[2, 3, 4, 5, 6].map(v => (
                <button key={v} onClick={() => setCalOctave(v)}
                  style={{ ...S.btn(calOctave === v ? '#4a9eff' : '#333'),
                           minWidth: 32, padding: '4px 8px', fontSize: 13 }}>
                  {v}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: '#888', fontSize: 12 }}>Difficulty:</span>
              {[{ label: 'Easy', value: 100 }, { label: 'Normal', value: 50 }, { label: 'Hard', value: 25 }].map(({ label, value }) => (
                <button key={value} onClick={() => setTolerance(value)}
                  style={{ ...S.btn(tolerance === value ? '#4a9eff' : '#333'),
                           padding: '4px 10px', fontSize: 12 }}>
                  {label}
                </button>
              ))}
            </div>
            {micLabel && <span style={{ color: '#555', fontSize: 12 }}>🎙 {micLabel}</span>}
          </div>
        </div>
      </div>
    );
  }

  // ── Practice phase ──────────────────────────────────────────────────
  const done = idx >= items.length;

  // Compute section markers from enriched items
  const sectionMarkers = [];
  { let last = null;
    items.forEach((item, i) => {
      if (item.section && item.section !== last) {
        sectionMarkers.push({ name: item.section, startIdx: i });
        last = item.section;
      }
    }); }
  const currentSection = [...sectionMarkers].reverse().find(s => s.startIdx <= idx)?.name;

  const STATUS_BG = { green: '#1a3a1a', yellow: '#2a2a0a', red: '#3a0a0a' };

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0d0d0d', overflow: 'hidden' }}>

      {/* Left: chord chart */}
      {chartText && (
        <div style={{ flex: '0 1 30%', minWidth: 260, maxWidth: 760, background: '#111', borderRight: '1px solid #1e1e1e',
                      overflowY: 'auto', overflowX: 'hidden', padding: '20px 18px', boxSizing: 'border-box' }}>
          <SectionLabel>Chart</SectionLabel>
          <ChartDisplay chartText={chartText} currentSection={currentSection} />
        </div>
      )}

      {/* Right: practice UI */}
      <div style={{ flex: '1 1 0', minWidth: 0, ...S.app, alignItems: 'stretch', overflowY: 'auto' }}>

        {chartWarning && (
          <div style={{ ...S.card, background: '#2a2105', border: '1px solid #5a4410',
                        padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ color: '#ffb347', fontSize: 16 }}>⚠</span>
            <span style={{ color: '#e0c070', fontSize: 13, flex: 1 }}>{chartWarning}</span>
            <button onClick={() => setChartWarning('')}
              style={{ background: 'transparent', color: '#8a7340', border: 'none', cursor: 'pointer',
                       fontSize: 16, padding: '0 4px' }}>×</button>
          </div>
        )}

        {/* Header */}
        <div style={{ ...S.card, paddingBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h1 style={{ ...S.h1, marginBottom: 0 }}>🎵 Singing Practice</h1>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => {
                setAutoPlay(false); autoPlayRef.current = false;
                setIdx(0); idxRef.current = 0;
                holdTimerRef.current = null;
                statusStreakRef.current = { status: null, count: 0, committed: null, greenCount: 0 };
                setItems(it => it.map(i => ({ ...i, status: null })));
              }} style={S.btn('#4a9eff')}>↺ Restart</button>
              <button onClick={resetPractice} style={S.btn('#555')}>⏹ Stop</button>
              <button onClick={() => setPhase('setup')} style={S.btn('#333')}>Edit</button>
            </div>
          </div>
        </div>

        {/* Section navigation */}
        {sectionMarkers.length > 0 && (
          <div style={{ ...S.card, paddingTop: 10, paddingBottom: 10 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ color: '#555', fontSize: 11, marginRight: 4 }}>Jump to:</span>
              {sectionMarkers.map(sec => (
                <button key={sec.name} onClick={() => {
                  setAutoPlay(false); autoPlayRef.current = false;
                  statusStreakRef.current = { status: null, count: 0, committed: null, greenCount: 0 };
                  setIdx(sec.startIdx); idxRef.current = sec.startIdx;
                }} style={{ ...S.btn(currentSection === sec.name ? '#4a9eff' : '#2a2a2a'),
                            padding: '3px 10px', fontSize: 12, color: currentSection === sec.name ? '#000' : '#aaa' }}>
                  {sec.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Note graph */}
        <SectionLabel>Pitch</SectionLabel>
        <div style={{ ...S.card, position: 'relative' }}>
          {!done ? (
            <>
              <MelodyLine items={items} idx={idx} canvasRef={pitchCanvasRef} octaveShift={octaveShift} bpm={bpm} />
              {!isListening && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                              color: '#777', fontSize: 13, pointerEvents: 'none', background: '#161616cc', borderRadius: 8 }}>
                  Click 🎤 Start Mic to begin
                </div>
              )}
              <div ref={centsBarRef} style={{ marginTop: 6, height: 24, borderRadius: 6, background: 'transparent',
                            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span ref={centsTextRef} style={{ fontWeight: 'bold', fontSize: 13, display: 'none' }} />
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', padding: '32px 0', fontSize: 24, color: '#4caf50' }}>
              🎉 Great job! Song complete.
            </div>
          )}
        </div>

        {/* Chord banner — current + next chord for guitar play-along */}
        {items.some(it => it.chord) && !done && (() => {
          const curChord = (() => {
            for (let i = Math.min(idx, items.length - 1); i >= 0; i--) if (items[i].chord) return items[i].chord;
            return null;
          })();
          let nextChord = null, nextIdx = -1;
          for (let i = idx + 1; i < items.length; i++) {
            if (items[i].chord && items[i].chord !== curChord) { nextChord = items[i].chord; nextIdx = i; break; }
          }
          const wordsToNext = nextIdx > -1 ? nextIdx - idx : null;
          return (
            <div style={{ ...S.card, display: 'flex', alignItems: 'baseline', gap: 24, padding: '12px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <span style={{ color: '#555', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>Now</span>
                <span style={{ fontSize: 38, fontWeight: 700, color: '#ffb347', fontFamily: 'monospace' }}>{curChord || '—'}</span>
              </div>
              {nextChord && (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, opacity: 0.7 }}>
                  <span style={{ color: '#555', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>Next</span>
                  <span style={{ fontSize: 22, color: '#888', fontFamily: 'monospace' }}>{nextChord}</span>
                  <span style={{ color: '#444', fontSize: 11 }}>in {wordsToNext} word{wordsToNext === 1 ? '' : 's'}</span>
                </div>
              )}
            </div>
          );
        })()}

        {/* Lyrics */}
        <SectionLabel>Lyrics</SectionLabel>
        <div style={S.card}>
          <div style={{ fontSize: 12, color: '#555', marginBottom: 6 }}>
            Word {Math.min(idx + 1, items.length)} / {items.length}
          </div>
          <LyricDisplay items={items} idx={idx} />
        </div>

        {/* Controls */}
        <SectionLabel>Controls</SectionLabel>
        <div style={{ ...S.card, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {!isListening
            ? <button onClick={startListening} style={S.btn('#4a9eff')}>🎤 Start Mic</button>
            : <button onClick={stopListening} style={S.btn('#f44336')}>⏹ Stop Mic</button>}
          <button onClick={advanceManual} disabled={done} style={S.btn('#555', done)}>Skip →</button>

          {!isPlaying ? (
            <>
              <button onClick={playNoteAudio} disabled={done} style={S.btn('#7b4fcf', done)} title="Hear the current note">♪ Note</button>
              <button onClick={playPhraseAudio} disabled={done} style={S.btn('#5a3a9f', done)} title="Hear next 8 notes">♫ Phrase</button>
              <button onClick={playAutoAll} disabled={done} style={S.btn('#3a2a7f', done)} title="Play every remaining note while advancing the highlight in sync">▶ Auto Play</button>
            </>
          ) : (
            <button onClick={stopPlayback} style={S.btn('#f44336')}>⏹ Stop</button>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
            <span style={{ color: '#888', fontSize: 12 }}>Octave:</span>
            {[-2, -1, 0, 1, 2].map(v => (
              <button key={v} onClick={() => setOctaveShift(v)}
                style={{ ...S.btn(octaveShift === v ? '#4a9eff' : '#333'), minWidth: 32, padding: '4px 8px', fontSize: 13 }}>
                {v > 0 ? `+${v}` : v}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
            <span style={{ color: '#888', fontSize: 12 }}>Pitch:</span>
            {[{ label: 'Easy', value: 100 }, { label: 'Normal', value: 50 }, { label: 'Hard', value: 25 }].map(({ label, value }) => (
              <button key={value} onClick={() => setTolerance(value)}
                style={{ ...S.btn(tolerance === value ? '#4a9eff' : '#333'), padding: '4px 10px', fontSize: 12 }}>
                {label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
            <span style={{ color: '#888', fontSize: 12 }}>BPM:</span>
            <input type="text" inputMode="numeric" pattern="[0-9]*" defaultValue={bpm}
              onChange={e => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= BPM_MIN && v <= BPM_MAX) setBpm(v); }}
              onBlur={e => { const v = parseInt(e.target.value, 10); const c = isNaN(v) ? 120 : Math.max(BPM_MIN, Math.min(BPM_MAX, v)); setBpm(c); e.target.value = String(c); }}
              style={{ width: 52, background: '#1a1a1a', color: '#fff', border: '1px solid #333',
                       borderRadius: 6, padding: '4px 8px', fontSize: 13, textAlign: 'center' }} />
            <button onClick={async () => { if (autoPlay) { setAutoPlay(false); } else { setHoldMode(false); setAutoPlay(true); if (!isListening) await startListening(); } }}
              style={{ ...S.btn(autoPlay ? '#ff9800' : '#4caf50'), padding: '6px 14px', fontSize: 13 }}>
              {autoPlay ? '⏸ Stop Auto' : '▶ Auto-play'}
            </button>
            <button onClick={async () => { if (holdMode) { setHoldMode(false); } else { setAutoPlay(false); setHoldMode(true); holdStartRef.current = null; if (!isListening) await startListening(); } }}
              style={{ ...S.btn(holdMode ? '#ff9800' : '#9c27b0'), padding: '6px 14px', fontSize: 13 }}
              title="Must hold each note for at least 1s (or its notated duration if longer)">
              {holdMode ? '⏸ Stop Hold' : '🎯 Hold'}
            </button>
          </div>

          {isListening && (
            <div style={{ flex: 1, height: 8, background: '#222', borderRadius: 4, overflow: 'hidden', minWidth: 80 }}>
              <div ref={micBarRef} style={{ width: '0%', height: '100%', background: '#4a9eff', borderRadius: 4 }} />
            </div>
          )}
          <span style={{ color: '#555', fontSize: 13, marginLeft: 'auto' }}>{statusMsg}<span ref={freqTextRef} /></span>
        </div>

        {/* Legend */}
        <div style={{ display: 'flex', gap: 20, fontSize: 12, color: '#555', marginTop: 4, flexWrap: 'wrap' }}>
          <span><span style={{ color: '#4caf50' }}>●</span> On pitch</span>
          <span><span style={{ color: '#ffeb3b' }}>●</span> Close</span>
          <span><span style={{ color: '#f44336' }}>●</span> Off</span>
          <span>↑↓ pitch direction</span>
        </div>
      </div>

      {/* Right: mini sheet music + guitar fretboard */}
      {!done && idx < items.length && (
        <div style={{ flex: '0 1 36%', minWidth: 320, maxWidth: 1000, background: '#0f0f0f', borderLeft: '1px solid #1e1e1e',
                      height: '100vh', overflowY: 'auto', overflowX: 'hidden',
                      padding: '12px 16px', boxSizing: 'border-box',
                      display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SectionLabel>Chords</SectionLabel>
          <ChordRail items={items} idx={idx} />
          <SectionLabel>Fretboard</SectionLabel>
          <GuitarFretboard items={items} idx={idx} neckPos={neckPos} onNeckPos={setNeckPos} />
          <SectionLabel>Tabs</SectionLabel>
          <TabStaff items={items} idx={idx} neckPos={neckPos} />
          <SectionLabel>Sheet Music</SectionLabel>
          {musicXml
            ? <SheetMusicOSMD musicXml={musicXml} idx={idx} />
            : <SheetMusicBars items={items} idx={idx} />}
        </div>
      )}
    </div>
  );
}
