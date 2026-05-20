"""
Local backend server for the Singing Practice App.
Accepts a PDF upload, runs Audiveris OMR, returns notes+lyrics as JSON.
Songs are cached as JSON files in songs_cache/ so they survive browser clears.

Run with:  python server.py
Listens on http://localhost:5001
"""
import os, re, glob, tempfile, subprocess, json
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

AUDIVERIS = r"C:\Program Files\Audiveris\Audiveris.exe"
CACHE_DIR = os.path.join(os.path.dirname(__file__), "songs_cache")
os.makedirs(CACHE_DIR, exist_ok=True)

# ── Song cache helpers ────────────────────────────────────────────────

def cache_path(filename):
    safe = re.sub(r'[^\w\-. ]', '_', filename)
    return os.path.join(CACHE_DIR, safe + ".json")

def musicxml_cache_path(filename):
    safe = re.sub(r'[^\w\-. ]', '_', filename)
    return os.path.join(CACHE_DIR, safe + ".musicxml")

def load_cached(filename):
    p = cache_path(filename)
    if os.path.exists(p):
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    return None

def save_cached(filename, notes, system_breaks=None, chart_text=None, bpm=None):
    existing = load_cached(filename) or {}
    payload = {
        "filename": filename,
        "notes": notes if notes is not None else existing.get("notes", []),
        "systemBreaks": system_breaks if system_breaks is not None else existing.get("systemBreaks", []),
        "chartText": chart_text if chart_text is not None else existing.get("chartText", ""),
        "bpm": bpm if bpm is not None else existing.get("bpm"),
    }
    with open(cache_path(filename), "w", encoding="utf-8") as f:
        json.dump(payload, f)

def delete_cached(filename):
    for p in (cache_path(filename), musicxml_cache_path(filename)):
        if os.path.exists(p):
            os.remove(p)

def list_cached():
    songs = {}
    for p in glob.glob(os.path.join(CACHE_DIR, "*.json")):
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            songs[data["filename"]] = {
                "filename": data["filename"],
                "notes": data["notes"],
                "systemBreaks": data.get("systemBreaks", []),
                "chartText": data.get("chartText", ""),
                "bpm": data.get("bpm"),
                "hasMusicXml": os.path.exists(musicxml_cache_path(data["filename"])),
                "savedAt": os.path.getmtime(p),
            }
        except Exception:
            pass
    return songs

# ── OMR helpers ───────────────────────────────────────────────────────

def run_audiveris(pdf_path, out_dir):
    def _run(args):
        r = subprocess.run(args, capture_output=True, text=True, timeout=600)
        print("=== Audiveris stdout ==="); print(r.stdout[-2000:] if r.stdout else "(none)")
        print("=== Audiveris stderr ==="); print(r.stderr[-500:]  if r.stderr else "(none)")
        print("=== Return code:", r.returncode, "===", flush=True)
        return r

    # First pass: standard run
    _run([AUDIVERIS, "-batch", "-export", "-output", out_dir, pdf_path])

    # If no XML yet, retry on the saved .omr file (transcription done, just re-export)
    if not find_xml(out_dir):
        omr_files = glob.glob(os.path.join(out_dir, "**", "*.omr"), recursive=True)
        if omr_files:
            print(">>> Retrying export from .omr file...", flush=True)
            _run([AUDIVERIS, "-batch", "-export", "-output", out_dir, omr_files[0]])

def find_xml(out_dir):
    for ext in ("*.mxl", "*.musicxml", "*.xml"):
        hits = [h for h in glob.glob(os.path.join(out_dir, "**", ext), recursive=True)
                if not h.endswith(".omr")]
        if hits:
            return sorted(hits, key=os.path.getsize)[-1]
    return None

def normalize(name):
    return re.sub(r"([A-G])-(\d)", r"\1b\2", name)


def extract_system_breaks(xml_path):
    """Parse MusicXML for the measure number that starts each new system/line."""
    import xml.etree.ElementTree as ET, zipfile, io
    try:
        if xml_path.lower().endswith('.mxl'):
            with zipfile.ZipFile(xml_path) as z:
                names = z.namelist()
                xml_name = next((n for n in names if n.endswith('.xml')
                                 and 'META-INF' not in n), None)
                if not xml_name:
                    return []
                with z.open(xml_name) as f:
                    content = f.read()
            root = ET.parse(io.BytesIO(content)).getroot()
        else:
            root = ET.parse(xml_path).getroot()

        ns_match = re.match(r'\{([^}]+)\}', root.tag)
        ns = ns_match.group(1) if ns_match else ''
        def q(n): return f'{{{ns}}}{n}' if ns else n

        breaks = []
        for part in root.findall(q("part")):
            for measure in part.findall(q("measure")):
                print_el = measure.find(q("print"))
                if print_el is not None:
                    if print_el.find(q("system-layout")) is not None:
                        breaks.append(int(measure.get("number", 0)))
            break  # layout is the same across parts
        print(f">>> System breaks at measures: {breaks}", flush=True)
        return breaks
    except Exception as e:
        print(f">>> extract_system_breaks error: {e}", flush=True)
        return []

def read_musicxml_text(xml_path):
    """Read the MusicXML from disk as a UTF-8 string. Handles both raw .xml and
    compressed .mxl (Audiveris emits either depending on version). Returns None
    on failure.
    """
    import zipfile
    try:
        if xml_path.lower().endswith('.mxl'):
            with zipfile.ZipFile(xml_path) as z:
                inner = next((n for n in z.namelist()
                              if n.lower().endswith('.xml') and 'META-INF' not in n), None)
                if not inner:
                    return None
                with z.open(inner) as f:
                    return f.read().decode('utf-8', errors='replace')
        with open(xml_path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()
    except Exception as e:
        print(f">>> read_musicxml_text error: {e}", flush=True)
        return None


def extract_bpm(xml_path):
    """Pull the first explicit tempo (BPM) from a MusicXML file.
    Looks for <sound tempo="N"/> first (Audiveris populates this when
    a metronome mark is detected) and falls back to a metronome element.
    Returns int BPM or None.
    """
    import xml.etree.ElementTree as ET, zipfile, re as _re
    try:
        if xml_path.lower().endswith('.mxl'):
            with zipfile.ZipFile(xml_path) as z:
                inner = next((n for n in z.namelist() if n.lower().endswith('.xml') and 'container' not in n.lower()), None)
                if not inner:
                    return None
                data = z.read(inner)
                root = ET.fromstring(data)
        else:
            root = ET.parse(xml_path).getroot()
        # <sound tempo="120"/> is the simplest signal
        for sound in root.iter('sound'):
            t = sound.get('tempo')
            if t:
                try:
                    bpm = int(round(float(t)))
                    if 30 <= bpm <= 320:
                        return bpm
                except ValueError:
                    pass
        # <metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome>
        for metronome in root.iter('metronome'):
            pm = metronome.find('per-minute')
            if pm is not None and pm.text:
                try:
                    bpm = int(round(float(pm.text)))
                    if 30 <= bpm <= 320:
                        return bpm
                except ValueError:
                    pass
        return None
    except Exception as e:
        print(f">>> extract_bpm error: {e}", flush=True)
        return None


# Italian / English tempo words → approximate BPM (mid of conventional range).
TEMPO_WORD_BPM = {
    'grave': 40, 'lento': 55, 'largo': 50, 'larghetto': 63,
    'adagio': 70, 'adagietto': 75,
    'andante': 90, 'andantino': 95,
    'moderato': 110, 'moderately': 110,
    'allegretto': 115, 'allegro': 140, 'vivace': 160, 'presto': 180, 'prestissimo': 200,
    'slowly': 70, 'quickly': 140, 'brightly': 130, 'fast': 140,
}

def extract_bpm_from_pdf(pdf_path):
    """Fallback: scan PDF text for an explicit metronome mark or a tempo word.
    Matches patterns like '♩ = 120', 'q = 120', 'quarter = 120', or the
    Italian/English tempo terms in TEMPO_WORD_BPM. Returns int or None.
    """
    import re as _re
    try:
        import pypdf
        reader = pypdf.PdfReader(pdf_path)
        text = ''
        for page in reader.pages[:2]:  # tempo always near the start
            try:
                text += '\n' + (page.extract_text() or '')
            except Exception:
                continue
        # Explicit metronome mark: "♩ = 120", "q = 96", "quarter = 100"
        m = _re.search(r'(?:♩|q|quarter)\s*[=:]\s*(\d{2,3})', text, _re.I)
        if m:
            bpm = int(m.group(1))
            if 30 <= bpm <= 320:
                return bpm
        # Compound words like "Moderately fast" — take the longer match by trying compound first
        lower = text.lower()
        for word in ('moderately fast', 'moderately slow'):
            if word in lower:
                return 120 if 'fast' in word else 100
        for word, bpm in TEMPO_WORD_BPM.items():
            if _re.search(r'\b' + _re.escape(word) + r'\b', lower):
                return bpm
        return None
    except Exception as e:
        print(f">>> extract_bpm_from_pdf error: {e}", flush=True)
        return None


def extract_notes(xml_path):
    from music21 import converter
    from music21.note import Note, Rest
    from music21.chord import Chord

    score = converter.parse(xml_path)

    vocal_part, best = None, -1
    for part in score.parts:
        count = sum(1 for n in part.flatten().notes if n.lyric)
        if count > best:
            best, vocal_part = count, part

    if vocal_part is None or best == 0:
        vocal_part = score.parts[0] if score.parts else None
    if vocal_part is None:
        return []

    def clean_lyric(raw):
        if not raw:
            return ""
        return raw.strip().strip("_").strip("-").strip()

    def beat_info(n):
        try:
            return float(n.beat), int(n.measureNumber)
        except Exception:
            return None, None

    rows = []
    for n in vocal_part.flatten().notesAndRests:
        if isinstance(n, Rest):
            continue
        beat, measure = beat_info(n)
        if isinstance(n, Note):
            lyric = clean_lyric(n.lyric)
            rows.append({"note": normalize(n.pitch.nameWithOctave), "lyric": lyric,
                         "duration": float(n.quarterLength), "beat": beat, "measure": measure})
        elif isinstance(n, Chord):
            lyric = clean_lyric(n.lyric)
            top = max(n.pitches, key=lambda p: p.midi)
            rows.append({"note": normalize(top.nameWithOctave), "lyric": lyric,
                         "duration": float(n.quarterLength), "beat": beat, "measure": measure})
    return rows

# ── Routes ────────────────────────────────────────────────────────────

@app.route("/extract", methods=["POST"])
def extract():
    print(">>> /extract called", flush=True)
    if "pdf" not in request.files:
        return jsonify({"error": "No PDF uploaded"}), 400

    pdf_file = request.files["pdf"]
    filename = pdf_file.filename
    if not filename.lower().endswith(".pdf"):
        return jsonify({"error": "File must be a PDF"}), 400

    # Return cached result if available
    cached = load_cached(filename)
    if cached:
        return jsonify({
            "notes": cached["notes"],
            "systemBreaks": cached.get("systemBreaks", []),
            "bpm": cached.get("bpm"),
            "count": len(cached["notes"]),
            "cached": True,
        })

    try:
        with tempfile.TemporaryDirectory(prefix="audiveris_") as tmp:
            pdf_path = os.path.join(tmp, "input.pdf")
            pdf_file.save(pdf_path)
            print(">>> PDF saved, launching Audiveris...", flush=True)
            run_audiveris(pdf_path, tmp)
            print(">>> Audiveris done, searching for XML...", flush=True)
            xml_file = find_xml(tmp)
            print(">>> XML found:" , xml_file, flush=True)
            if not xml_file:
                return jsonify({"error": "Audiveris produced no XML output. Try a cleaner scan."}), 422
            notes = extract_notes(xml_file)
            system_breaks = extract_system_breaks(xml_file)
            bpm = extract_bpm(xml_file) or extract_bpm_from_pdf(pdf_path)
            print(f">>> detected BPM: {bpm}", flush=True)
            musicxml = read_musicxml_text(xml_file)
            if musicxml:
                with open(musicxml_cache_path(filename), 'w', encoding='utf-8') as f:
                    f.write(musicxml)
                print(f">>> cached MusicXML ({len(musicxml)} chars)", flush=True)
            # Client (assignLyricsFromChordPairs) re-derives lyrics from the chord chart
            # using proximity-filtered PDF text. We no longer trust Audiveris lyric tags
            # or pypdf fallback text — both leak title/credits/tempo into note.lyric.
            for n in notes:
                n['lyric'] = ''
            print(f">>> kept {len(notes)} notes (lyrics cleared; client will re-assign from chord chart)", flush=True)
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print("OMR ERROR:", tb)
        return jsonify({"error": f"OMR processing error: {e}", "detail": tb}), 500

    if not notes:
        return jsonify({"error": "No notes found in the score."}), 422

    save_cached(filename, notes, system_breaks, bpm=bpm)
    return jsonify({"notes": notes, "systemBreaks": system_breaks, "bpm": bpm, "count": len(notes)})

@app.route("/songs", methods=["GET"])
def songs():
    return jsonify(list_cached())

@app.route("/songs/<path:filename>/musicxml", methods=["GET"])
def get_musicxml(filename):
    p = musicxml_cache_path(filename)
    if not os.path.exists(p):
        return jsonify({"error": "MusicXML not cached for this song"}), 404
    with open(p, 'r', encoding='utf-8') as f:
        text = f.read()
    return text, 200, {"Content-Type": "application/vnd.recordare.musicxml+xml; charset=utf-8"}

@app.route("/songs/<path:filename>", methods=["DELETE"])
def delete_song(filename):
    delete_cached(filename)
    return jsonify({"ok": True})

@app.route("/songs/<path:filename>/chart", methods=["PUT"])
def save_chart(filename):
    body = request.get_json(silent=True) or {}
    chart_text = body.get("chartText", "")
    existing = load_cached(filename)
    if not existing:
        return jsonify({"error": "Song not in cache"}), 404
    save_cached(filename, existing.get("notes"), existing.get("systemBreaks"), chart_text)
    return jsonify({"ok": True})

DEBUG_LOG_PATH = os.path.join(os.path.dirname(__file__), "debug.log")

@app.route("/debug-log", methods=["POST"])
def debug_log():
    """Accepts JSON {tag, data} and appends to debug.log so Claude can read it."""
    payload = request.get_json(silent=True) or {}
    tag = payload.get("tag", "log")
    data = payload.get("data")
    with open(DEBUG_LOG_PATH, "a", encoding="utf-8") as f:
        f.write(f"=== {tag} ===\n")
        f.write(json.dumps(data, indent=2, default=str) + "\n\n")
    return jsonify({"ok": True})

@app.route("/debug-log/clear", methods=["POST"])
def debug_log_clear():
    open(DEBUG_LOG_PATH, "w").close()
    return jsonify({"ok": True})

@app.route("/health")
def health():
    return jsonify({"ok": True})

if __name__ == "__main__":
    print("Singing Practice backend running on http://localhost:5001")
    print(f"Song cache: {CACHE_DIR}")
    app.run(port=5001, debug=False, threaded=True)
