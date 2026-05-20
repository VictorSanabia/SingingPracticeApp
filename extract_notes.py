#!/usr/bin/env python3
"""
PDF sheet music  →  JSON notes + lyrics
Pipeline: PDF → Audiveris (OMR) → MusicXML → music21 → JSON

Usage:
    python extract_notes.py song.pdf                  # prints JSON to stdout
    python extract_notes.py song.pdf output.json      # saves to file
"""
import sys, os, json, subprocess, tempfile, glob, re
from pathlib import Path

AUDIVERIS = r"C:\Program Files\Audiveris\Audiveris.exe"

# ── Step 1: run Audiveris ────────────────────────────────────────────
def run_audiveris(pdf_path: str, out_dir: str) -> None:
    print("[1/3] Running Audiveris OMR — this can take 1-3 min per page...", file=sys.stderr)
    result = subprocess.run(
        [AUDIVERIS, "-batch", "-export", "-output", out_dir, pdf_path],
        capture_output=True, text=True, timeout=600
    )
    # Audiveris often returns non-zero even on success — just log stderr
    if result.stderr:
        # Only show the last meaningful lines
        lines = [l for l in result.stderr.splitlines() if "ERROR" in l or "WARN" in l or "INFO" in l]
        for l in lines[-10:]:
            print(" ", l, file=sys.stderr)

# ── Step 2: find MusicXML output ────────────────────────────────────
def find_output_xml(out_dir: str) -> str | None:
    for ext in ("*.mxl", "*.musicxml", "*.xml"):
        hits = glob.glob(os.path.join(out_dir, "**", ext), recursive=True)
        # filter out Audiveris internal OMR project files
        hits = [h for h in hits if not h.endswith(".omr")]
        if hits:
            return sorted(hits, key=os.path.getsize)[-1]  # largest = most complete
    return None

# ── Step 3: parse MusicXML, extract vocal line ──────────────────────
def normalize(name: str) -> str:
    """music21 uses 'B-4' for Bb — normalise to 'Bb4' for the browser app."""
    return re.sub(r"([A-G])-(\d)", r"\1b\2", name)

def extract_vocal_notes(xml_path: str) -> list[dict]:
    from music21 import converter
    from music21.note import Note
    from music21.chord import Chord

    print(f"[2/3] Parsing {Path(xml_path).name} with music21 ...", file=sys.stderr)
    score = converter.parse(xml_path)

    # Identify the vocal part: the part with the most notes that have lyrics
    vocal_part = None
    best = -1
    for part in score.parts:
        count = sum(1 for n in part.flat.notes if n.lyric)
        print(f"      Part '{part.partName}': {count} notes with lyrics", file=sys.stderr)
        if count > best:
            best = count
            vocal_part = part

    if vocal_part is None or best == 0:
        # No lyrics found anywhere — fall back to first part and take all notes
        print("      No lyrics detected — falling back to first part", file=sys.stderr)
        vocal_part = score.parts[0] if score.parts else None

    if vocal_part is None:
        return []

    rows = []
    for n in vocal_part.flat.notes:
        if isinstance(n, Note):
            rows.append({"note": normalize(n.pitch.nameWithOctave), "lyric": n.lyric or ""})
        elif isinstance(n, Chord):
            # Shouldn't happen in a vocal line, but take the highest pitch
            top = max(n.pitches, key=lambda p: p.midi)
            rows.append({"note": normalize(top.nameWithOctave), "lyric": n.lyric or ""})

    # If we have any lyrics, drop note-only rows that are just instrumental bridges
    # (runs of notes with no lyric between lyric-bearing notes are kept for continuity)
    lyric_count = sum(1 for r in rows if r["lyric"])
    print(f"      Extracted {len(rows)} notes, {lyric_count} with lyrics", file=sys.stderr)
    return rows

# ── Main ─────────────────────────────────────────────────────────────
def main():
    if len(sys.argv) < 2:
        sys.exit("Usage: python extract_notes.py <sheet_music.pdf> [output.json]")

    pdf_path = os.path.abspath(sys.argv[1])
    out_json  = sys.argv[2] if len(sys.argv) > 2 else None

    if not os.path.isfile(pdf_path):
        sys.exit(f"File not found: {pdf_path}")

    out_dir = tempfile.mkdtemp(prefix="audiveris_out_")

    run_audiveris(pdf_path, out_dir)

    xml_file = find_output_xml(out_dir)
    if not xml_file:
        sys.exit("Audiveris produced no MusicXML output. The PDF may be too low-quality or not sheet music.")

    notes = extract_vocal_notes(xml_file)

    payload = {"notes": notes, "count": len(notes), "source": os.path.basename(xml_file)}
    result  = json.dumps(payload, ensure_ascii=False, indent=2)

    if out_json:
        with open(out_json, "w", encoding="utf-8") as f:
            f.write(result)
        print(f"[3/3] Saved {len(notes)} notes → {out_json}", file=sys.stderr)
    else:
        print(result)
        print(f"[3/3] Done — {len(notes)} notes extracted.", file=sys.stderr)

if __name__ == "__main__":
    main()
