// Standalone test harness for the chord-extraction + walk-forward lyric
// assignment. Loads the PDF via pdfjs-dist (Node legacy build), reads cached
// OMR notes from the songs_cache JSON, and prints assignments. Allows
// iterating on the algorithm without manual browser reloads.
//
// Usage: node test_walk_forward.mjs
//
// To swap algorithms: edit `assignLyricsFromChordPairs` at the bottom. The
// chord-extraction logic is a faithful port of App.jsx — do NOT diverge it.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load pdfjs-dist legacy build (Node-compatible)
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const PDF_PATH = 'C:/Users/Victor/Documents/Sheet Muisc/choosin texas.pdf';
const CACHE_PATH = path.join(__dirname, 'songs_cache', 'choosin texas.pdf.json');

// ── Shared regexes & helpers (copied verbatim from App.jsx) ─────────────
const MUSIC_FONT_RE = /[ÏÎïîúùÈèÀáÂâÄäÀ-ÅÈ-ÏÒ-ÖÙ-Ýà-åè-ïò-öù-ý]/;
const NON_CONTENT_RE = /copyright|©|\(c\)|all\s*right|reserved|international|unauthorized|reproduction|prohibited|transmission|duplication|hal.?leonard|warner|sony|kobalt|alfred|music sales|cherry lane|publish|copies licensed|p\.\s*\d+\s*of\s*\d+|transcribed|arranged\s*by|engraved|licensed|digital|sheet\s*music|words\s*(and|&)\s*music|music\s*by|lyrics\s*by|words\s*by|from\s*the\s*(musical|movie|film|album)|moderately|slowly|quickly|brightly|allegro|andante|adagio|\brit\.|d\.s\.?\s*al|d\.c\.?\s*al|to\s*coda|\(instr|\(spoken|additional\s*lyric|additonal|see\s+additional|^\s*\(\d+\.\)|\bgently\b|\bwith\s*(feeling|a\s+lilt|spirit|swing|energy)\b|performance\s*note|play\s*\d|=\s*\d+(\s*[-–]\s*\d+)?|^\s*coda\s+[ivx]+\s*$|^\s*=?\s*\d{2,3}\s*[-–]\s*\d{2,3}\s*$/i;
const SECTION_LABEL_RE = /^(verse|chorus|bridge|intro|outro|pre.?chorus|hook|tag|interlude|refrain|coda|vamp|solo|breakdown|ending)(\s*\d+)?$/i;
const STAFF_PROXIMITY_PT = 80;
const BPM_MIN = 40;
const BPM_MAX = 300;

function collectStaffYs(items) {
  const map = new Map();
  for (const it of items) {
    if (!MUSIC_FONT_RE.test(it.s)) continue;
    if (!map.has(it.page)) map.set(it.page, []);
    map.get(it.page).push(it.y);
  }
  return map;
}

function nearStaff(staffMap, page, y, { side = 'either', maxDist = STAFF_PROXIMITY_PT } = {}) {
  const ys = staffMap.get(page);
  if (!ys || !ys.length) return false;
  return ys.some(sy => {
    const diff = sy - y;
    if (side === 'below') return diff > 0 && diff <= maxDist;
    return Math.abs(diff) <= maxDist;
  });
}

function classifyNonContent(joined) {
  const trimmed = joined.trim();
  if (NON_CONTENT_RE.test(joined)) return 'noise';
  if (SECTION_LABEL_RE.test(trimmed)) return 'section';
  return null;
}

// ── Chord chart extraction (ported from App.jsx) ────────────────────────
async function extractChordChartFromPdf(pdfPath) {
  const data = new Uint8Array(await fs.readFile(pdfPath));
  const pdf = await pdfjsLib.getDocument({ data }).promise;

  const CHORD_RE = /^[A-G][#b]?(maj7?|min7?|m7?|dim7?|aug|sus[24]?|add\d?|\/[A-G][#b]?|\d+)*$/;

  const allItems = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const { items } = await page.getTextContent();
    for (const it of items) {
      const raw = it.str;
      const s = raw.trim();
      if (!s) continue;
      const hasTrailingSpace = /\s$/.test(raw);
      const h = it.height > 0 ? it.height : Math.abs(it.transform[3]);
      allItems.push({ s, x: it.transform[4], y: it.transform[5], page: p, w: it.width || 0, h, hasTrailingSpace });
    }
  }

  const heights = allItems.map(i => i.h).filter(h => h > 0).sort((a, b) => a - b);
  const medH = heights[Math.floor(heights.length / 2)] || 10;
  const BIG_FONT = medH * 1.5;

  const rowMap = new Map();
  for (const it of allItems) {
    const key = `${it.page}-${Math.round(it.y / 5)}`;
    if (!rowMap.has(key)) rowMap.set(key, { page: it.page, y: it.y, rawItems: [] });
    rowMap.get(key).rawItems.push(it);
  }

  const notationYs = collectStaffYs(allItems);

  const staffLines = [];
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
    staffLines.push({ page: row.page, y: row.y, glyphXs });
  }

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

  function mergeFlats(items) {
    const sortedAll = [...items].sort((a, b) => a.x - b.x);
    const beatMarkers = sortedAll.filter(i => /^[234]$/.test(i.s));
    const s = sortedAll.filter(i => !/^[234]$/.test(i.s));
    const SUFFIX_PIECE = '(?:maj|min|dim|aug|sus|add|m|\\/[A-G][#b]?|\\d{1,2})';
    const SUFFIX_RE = new RegExp(`^${SUFFIX_PIECE}+$`, 'i');
    const GAP_ACCIDENTAL = 70;
    const GAP_SUFFIX = 90;
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
    return [...out, ...beatMarkers].sort((a, b) => a.x - b.x);
  }

  const rows = [];
  for (const row of rowMap.values()) {
    row.rawItems.sort((a, b) => a.x - b.x);
    if (row.rawItems.some(i => MUSIC_FONT_RE.test(i.s))) continue;
    if (!nearStaff(notationYs, row.page, row.y)) continue;
    const ys = notationYs.get(row.page) || [];
    const nearestStaffY = ys.reduce((best, ny) => Math.abs(ny - row.y) < Math.abs(best - row.y) ? ny : best, ys[0]);
    const distToStaff = nearestStaffY != null ? Math.round(row.y - nearestStaffY) : null;
    const bigItems = row.rawItems.filter(i => i.h >= BIG_FONT);
    if (bigItems.length && bigItems.length === row.rawItems.length) continue;
    const joined = row.rawItems.map(i => i.s).join(' ');
    if (classifyNonContent(joined)) continue;
    const alphaRuns = joined.match(/[A-Za-z]{2,}/g) || [];
    const upperRuns = alphaRuns.filter(s => /^[A-Z]{3,}$/.test(s));
    if (alphaRuns.length >= 2 && upperRuns.length >= Math.ceil(alphaRuns.length * 0.5)) continue;

    const cleanedItems = row.rawItems.filter(it => {
      const s = it.s;
      if (/^coda$/i.test(s)) return false;
      if (/^[IVX]{1,4}$/i.test(s) && s.length <= 4 && s !== 'I7' && s !== 'IV7') return false;
      if (/^(mp|mf|pp|ff|p|f)$/.test(s)) return false;
      if (/^=$/.test(s)) return false;
      if (/^\d{2,3}$/.test(s) && +s >= BPM_MIN && +s <= BPM_MAX) return false;
      return true;
    });
    const merged = mergeFlats(cleanedItems);
    const tokens = merged.map(i => i.s);
    const chordItems = merged.filter(i => CHORD_RE.test(i.s));
    const hasMeasure = tokens.some(t => /^\d+$/.test(t) && +t < 500);
    const hasWords = tokens.some(t => t.length >= 2 && /[a-z]/i.test(t) && !CHORD_RE.test(t) && !/^\d+$/.test(t));
    const hasRealChord = chordItems.some(i => i.s.length >= 2);
    const isBelowStaff = distToStaff != null && distToStaff < 0;

    let type = 'other';
    if ((hasMeasure || chordItems.length >= 2) && hasRealChord && !hasWords) type = 'chords';
    else if (hasWords && isBelowStaff) type = 'lyrics';

    if (type !== 'other') {
      rows.push({ page: row.page, y: row.y, type, rawItems: row.rawItems, merged, chordItems });
    }
  }

  rows.sort((a, b) => a.page - b.page || b.y - a.y);

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
  return result;
}

// ── Walk-forward lyric assignment (current algo) ────────────────────────
function assignLyricsFromChordPairs(notes, chordPairs, systemBreaks = []) {
  if (!notes.length || !chordPairs.length) return { notes, diag: { reason: 'no pairs or notes' } };

  // Include both 'pair' and 'lyrics-only' entries (chord rows reuse lyrics
  // sometimes — without lyrics-only, we'd miss ~half the song). Filter page
  // watermarks at y<50.
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
  if (!lyricBearing.length) return { notes, diag: { reason: 'no lyric-bearing entries' } };

  lyricBearing.sort((a, b) => a.row.page - b.row.page || b.row.y - a.row.y);

  const explicit = lyricBearing.map(e => {
    if (e.type !== 'pair') return null;
    const tokens = (e.chordRow.merged || []).map(i => i.s);
    const m = tokens.find(t => /^\d+$/.test(t));
    return m != null ? +m : null;
  });
  const pairs = lyricBearing;

  const breaks = Array.isArray(systemBreaks) ? [...systemBreaks].sort((a, b) => a - b) : [];
  // Extrapolate past the last break for outro lyric lines beyond Audiveris's reach.
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
      const j = i + offset;
      if (j >= 0 && j < breaks.length) startMeasure = breaks[j];
      if (j + 1 < breaks.length) endMeasure = breaks[j + 1];
    }
    const sylItems = (p.row.rawItems || [])
      .map(it => ({ s: it.s.trim().replace(/\(.*?\)/g, '').trim(), x: it.x }))
      .filter(it => it.s && !/^\d+\.?$/.test(it.s));
    return { startMeasure, endMeasure, sylItems, glyphXs: p.staffGlyphXs || [], explicit: explicit[i], pairIdx: i };
  }).filter(s => s.startMeasure != null);

  systems.sort((a, b) => a.startMeasure - b.startMeasure);

  const out = notes.map(n => ({ ...n, lyric: '' }));
  const sysDiag = [];
  // Carryover: syllables that didn't fit on the previous system's notes,
  // typically the tail of a hyphenated word (e.g. "T en - nes -" continuing
  // into the next line's "see" → spells "Tennessee" across the two lines).
  let carryover = [];

  for (let i = 0; i < systems.length; i++) {
    const { startMeasure, endMeasure, sylItems, glyphXs, explicit: exp, pairIdx } = systems[i];
    const end = endMeasure ?? (i + 1 < systems.length ? systems[i + 1].startMeasure : Infinity);
    const noteIdxs = [];
    for (let j = 0; j < out.length; j++) {
      if (out[j].measure != null && out[j].measure >= startMeasure && out[j].measure < end) noteIdxs.push(j);
    }

    let mode, assignments = 0, continuations = 0;
    const sortedSyl = [...sylItems].sort((a, b) => a.x - b.x);
    const gN = glyphXs.length, nN = noteIdxs.length, sN = sortedSyl.length;
    // Anchor note x-positions to the SYLLABLE x range, not the glyph x range.
    // Glyph detection misses the leftmost/rightmost noteheads in many PDFs
    // (e.g. when key signatures aren't tagged as music-font), which skews
    // proportional mapping. The syllable layout reflects the actual notehead
    // layout — syllables are positioned under their notes by the engraver.
    const sylMin = sN > 0 ? sortedSyl[0].x : null;
    const sylMax = sN > 0 ? sortedSyl[sN - 1].x : null;
    const noteXs = noteIdxs.map((_, k) => {
      if (sN === 0) return null;
      if (nN === 1 || sN === 1) return sylMin;
      return sylMin + (k / (nN - 1)) * (sylMax - sylMin);
    });

    let carriedIn = carryover.length;
    let carriedOut = 0;
    if ((sN > 0 || carryover.length > 0) && nN > 0) {
      mode = 'claim-then-fill';
      // owners[k] = syllable object (not index), so carryover syllables from
      // previous systems can be stored alongside this system's syllables.
      const owners = new Array(nN).fill(null);
      let cursor = 0;
      const nextCarryover = [];

      // Phase 1 — drain carryover into leading notes unconditionally (x not
      // meaningful across systems). Whatever doesn't fit pushes forward again.
      let ci = 0;
      while (ci < carryover.length && cursor < nN) {
        owners[cursor++] = carryover[ci++];
      }
      while (ci < carryover.length) nextCarryover.push(carryover[ci++]);

      // Phase 2 — this system's syllables claim by x with monotonic cursor.
      let s = 0;
      for (; s < sN; s++) {
        const sx = sortedSyl[s].x;
        while (cursor < nN && noteXs[cursor] < sx) cursor++;
        if (cursor >= nN) break;
        owners[cursor++] = sortedSyl[s];
      }
      for (let r = s; r < sN; r++) nextCarryover.push(sortedSyl[r]);

      // Render. Unclaimed notes inherit the previous syllable as "-".
      let lastSyl = null;
      for (let k = 0; k < nN; k++) {
        let syl = owners[k];
        let isCont = false;
        if (!syl) {
          if (!lastSyl) continue;
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
    } else if (sortedSyl.length > 0 && nN > 0) {
      mode = 'fallback-index';
      sortedSyl.forEach((sit, k) => {
        if (k < nN) { out[noteIdxs[k]] = { ...out[noteIdxs[k]], lyric: sit.s }; assignments++; }
      });
    }

    sysDiag.push({
      pairIdx, startMeasure, end, explicit: exp, mode,
      sylCount: sortedSyl.length, glyphCount: gN, noteCount: nN,
      assigned: assignments, continuations,
      carriedIn, carriedOut,
      sortedSyllables: sortedSyl.slice(0, 14).map(s => ({ s: s.s, x: Math.round(s.x) })),
      glyphXs: glyphXs.slice(0, 16).map(x => Math.round(x)),
      noteXsFirst: noteXs.slice(0, 14).map(x => x != null ? Math.round(x) : null),
      assignedLyrics: noteIdxs.slice(0, 14).map(j => ({ measure: out[j].measure, note: out[j].note, lyric: out[j].lyric })),
    });
  }

  return { notes: out, diag: { pairCount: pairs.length, systemCount: systems.length, breaksCount: breaks.length, breakOffset: offset, systems: sysDiag } };
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log('--- Loading cached OMR data ---');
  const cache = JSON.parse(await fs.readFile(CACHE_PATH, 'utf-8'));
  console.log(`Notes: ${cache.notes.length}, systemBreaks: [${cache.systemBreaks.join(',')}]`);

  console.log('\n--- Running chord-chart extraction ---');
  const pairs = await extractChordChartFromPdf(PDF_PATH);
  const pairType = pairs.filter(p => p.type === 'pair');
  console.log(`Total entries: ${pairs.length}, type=pair: ${pairType.length}`);

  console.log('\n=== ALL entries (pair + lyrics-only + chords-only) ===');
  for (let i = 0; i < pairs.length; i++) {
    const e = pairs[i];
    const row = e.lyricRow || e.row;
    const raw = row?.rawItems
      ? [...row.rawItems].sort((a, b) => a.x - b.x).map(it => it.s).join(' ')
      : '(no row)';
    console.log(`  ${String(i).padStart(2)} ${e.type.padEnd(13)} p${row?.page} y${Math.round(row?.y || 0)}  ${raw}`);
  }

  console.log('\n--- Running walk-forward lyric assignment ---');
  const { notes, diag } = assignLyricsFromChordPairs(cache.notes, pairs, cache.systemBreaks);

  console.log('\n=== DIAG ===');
  console.log(`pairCount: ${diag.pairCount}, systemCount: ${diag.systemCount}, breakOffset: ${diag.breakOffset}`);

  // Focus on system 0 — that's where "Just" should land on Db5
  const sys0 = diag.systems[0];
  console.log('\n=== SYSTEM 0 (should map "Just" → m.6 Db5) ===');
  console.log(`startMeasure: ${sys0.startMeasure}, end: ${sys0.end}, explicit: ${sys0.explicit}`);
  console.log(`mode: ${sys0.mode}, syl/glyph/note: ${sys0.sylCount}/${sys0.glyphCount}/${sys0.noteCount}`);
  console.log(`assigned: ${sys0.assigned}, continuations: ${sys0.continuations}`);
  console.log(`\nsortedSyllables (s, x):`);
  for (const { s, x } of sys0.sortedSyllables) console.log(`  ${x.toString().padStart(5)} → ${JSON.stringify(s)}`);
  console.log(`\nglyphXs: [${sys0.glyphXs.join(', ')}]`);
  console.log(`\nnoteXs (first 14, estimated): [${sys0.noteXsFirst.join(', ')}]`);
  console.log(`\nassignedLyrics (first 14):`);
  for (const { measure, note, lyric } of sys0.assignedLyrics) {
    console.log(`  m.${measure} ${note.padEnd(4)} → ${JSON.stringify(lyric)}`);
  }

  // Show all sung notes grouped by system for review
  console.log(`\n=== Sung notes by system ===`);
  for (const sys of diag.systems) {
    const sysNotes = notes.filter(n => n.measure != null && n.measure >= sys.startMeasure && n.measure < sys.end && n.lyric);
    const txt = sysNotes.map(n => n.lyric === '-' ? '-' : `[${n.lyric}]`).join(' ');
    console.log(`  pair ${sys.pairIdx} m.${sys.startMeasure}-${sys.end - 1}  syl=${sys.sylCount} note=${sys.noteCount}  ${txt}`);
  }

  // Show full sequence of first 40 sung notes (note-level detail)
  const sung = notes.filter(n => n.lyric).slice(0, 40);
  console.log(`\n=== First 40 sung notes ===`);
  for (const n of sung) console.log(`  m.${n.measure} ${n.note.padEnd(4)} → ${JSON.stringify(n.lyric)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
