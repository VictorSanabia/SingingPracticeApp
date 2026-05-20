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

// CLI: `node test_walk_forward.mjs "Fix You.pdf"` — defaults to choosin texas.
const PDF_NAME = process.argv[2] || 'choosin texas.pdf';
const PDF_PATH = `C:/Users/Victor/Documents/Sheet Muisc/${PDF_NAME}`;
// Cache key matches server.py: re.sub(r'[^\w\-. ]', '_', filename)
const CACHE_KEY = PDF_NAME.replace(/[^\w\-. ]/g, '_');
const CACHE_PATH = path.join(__dirname, 'songs_cache', CACHE_KEY + '.json');

// ── Shared regexes & helpers (copied verbatim from App.jsx) ─────────────
const MUSIC_FONT_RE = /[ÏÎïîúùÈèÀáÂâÄäÀ-ÅÈ-ÏÒ-ÖÙ-Ýà-åè-ïò-öù-ý]/;
const NON_CONTENT_RE = /copyright|©|\(c\)|all\s*right|reserved|international|unauthorized|reproduction|prohibited|transmission|duplication|hal.?leonard|warner|sony|kobalt|alfred|music sales|cherry lane|publish|copies licensed|p\.\s*\d+\s*of\s*\d+|transcribed|arranged\s*by|engraved|licensed|digital|sheet\s*music|words\s*(and|&)\s*music|music\s*by|lyrics\s*by|words\s*by|from\s*the\s*(musical|movie|film|album)|moderately|slowly|quickly|brightly|allegro|andante|adagio|\brit\.|d\.s\.?\s*al|d\.c\.?\s*al|to\s*coda|\(instr|\(spoken|additional\s*lyric|additonal|see\s+additional|^\s*\(\d+\.\)|\bgently\b|\bwith\s*(feeling|a\s+lilt|spirit|swing|energy)\b|performance\s*note|play\s*\d|=\s*\d+(\s*[-–]\s*\d+)?|^\s*coda\s+[ivx]+\s*$|^\s*=?\s*\d{2,3}\s*[-–]\s*\d{2,3}\s*$|\bpedal\b|\bcont\.?\s*sim\.?|\b8va\b|2°|¡/i;
const SECTION_LABEL_RE = /^(verse|chorus|bridge|intro|outro|pre.?chorus|hook|tag|interlude|refrain|coda|vamp|solo|breakdown|ending)(\s*\d+)?$/i;
const STAFF_PROXIMITY_PT = 80;
const BPM_MIN = 40;
const BPM_MAX = 300;

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

  const CHORD_RE = /^([A-G][#b]?(maj7?|min7?|m7?|dim7?|aug|sus[24]?|add\d?|\/[A-G][#b]?|\d+)*|N\.?C\.?)$/;

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
    if (glyphXs.length < MIN_GLYPHS_PER_STAFF) continue;
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

    // Guitar chord-shape diagram filter
    const expanded = row.rawItems
      .flatMap(i => i.s.split(/\s+/))
      .map(s => s.trim())
      .filter(s => s);
    const xoCount = expanded.filter(s => /^[xo]$/i.test(s)).length;
    const realWordCount = expanded.filter(s => /^[a-z]{2,}/i.test(s)).length;
    if (xoCount >= 5 && realWordCount <= 1) continue;
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
      const finalItems = type === 'lyrics' ? splitMultiWord(row.rawItems) : row.rawItems;
      rows.push({ page: row.page, y: row.y, type, rawItems: finalItems, merged, chordItems });
    }
  }

  rows.sort((a, b) => a.page - b.page || b.y - a.y);

  // Multi-stanza dedup
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
    const BEATS_PER_MEASURE = 4;
    const times = noteIdxs.map(j => {
      const n = notes[j];
      return (n.measure ?? 0) * BEATS_PER_MEASURE + (n.beat ?? 1);
    });
    const tMin = times.length ? times[0] : 0;
    const tMax = times.length ? times[times.length - 1] : 0;
    const noteXs = times.map(t => {
      if (sN === 0) return null;
      if (nN === 1 || sN === 1 || tMax === tMin) return sylMin;
      return sylMin + ((t - tMin) / (tMax - tMin)) * (sylMax - sylMin);
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

      // Phase 2 — claim by nearest note from cursor (short words like "in"
      // sit at their left edge but their notehead is a few pt to the right).
      let s = 0;
      for (; s < sN; s++) {
        const sx = sortedSyl[s].x;
        let bestK = -1;
        let bestD = Infinity;
        for (let k = cursor; k < nN; k++) {
          const d = Math.abs(noteXs[k] - sx);
          if (d < bestD) { bestD = d; bestK = k; }
          else if (bestK >= 0) break;
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
  console.log(`\n############################################################`);
  console.log(`# ${PDF_NAME}`);
  console.log(`############################################################`);
  console.log('--- Loading cached OMR data ---');
  // Some old caches contain bare NaN (invalid JSON) — coerce to null on read.
  const raw = await fs.readFile(CACHE_PATH, 'utf-8');
  const cache = JSON.parse(raw.replace(/\bNaN\b/g, 'null'));
  console.log(`Notes: ${cache.notes.length}, systemBreaks: [${cache.systemBreaks.join(',')}]`);

  console.log('\n--- Running chord-chart extraction ---');
  const pairs = await extractChordChartFromPdf(PDF_PATH);
  const pairType = pairs.filter(p => p.type === 'pair');
  const lyricsOnly = pairs.filter(p => p.type === 'lyrics-only');
  console.log(`Total entries: ${pairs.length}, pair: ${pairType.length}, lyrics-only: ${lyricsOnly.length}`);

  console.log('\n=== Raw lyric/pair entries ===');
  for (let i = 0; i < pairs.length; i++) {
    const e = pairs[i];
    if (e.type === 'chords-only') continue;
    const row = e.lyricRow || e.row;
    const raw = row?.rawItems
      ? [...row.rawItems].sort((a, b) => a.x - b.x).map(it => it.s).join(' ')
      : '(no row)';
    console.log(`  ${String(i).padStart(2)} ${e.type.padEnd(13)} p${row?.page} y${Math.round(row?.y || 0)}  ${raw}`);
  }

  console.log('\n--- Running lyric assignment ---');
  const { notes, diag } = assignLyricsFromChordPairs(cache.notes, pairs, cache.systemBreaks);

  console.log(`pairCount: ${diag.pairCount}, systemCount: ${diag.systemCount}, breakOffset: ${diag.breakOffset}`);
  if (!diag.systems) {
    console.log(`\n(no systems — reason: ${diag.reason})`);
    console.log(`\n=== Cache MusicXML lyrics (fallback view, first 40) ===`);
    for (const n of cache.notes.slice(0, 40)) {
      console.log(`  m.${n.measure} ${(n.note || '').padEnd(4)} → ${JSON.stringify(n.lyric || '')}`);
    }
    return;
  }

  console.log(`\n=== Sung notes by system ===`);
  for (const sys of diag.systems) {
    const sysNotes = notes.filter(n => n.measure != null && n.measure >= sys.startMeasure && n.measure < sys.end && n.lyric);
    const txt = sysNotes.map(n => n.lyric === '-' ? '-' : `[${n.lyric}]`).join(' ');
    console.log(`  pair ${sys.pairIdx} m.${sys.startMeasure}-${sys.end - 1}  syl=${sys.sylCount} note=${sys.noteCount}  ${txt}`);
  }

  // Full reconstructed lyric string (in note-sequence order)
  const sung = notes.filter(n => n.lyric);
  const flat = sung.map(n => n.lyric).filter(l => l !== '-').join(' ');
  console.log(`\n=== Reconstructed lyric (note-order, hold-markers dropped) ===`);
  console.log(flat);
}

main().catch(e => { console.error(e); process.exit(1); });
