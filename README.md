# Singing Practice App

A web application that helps with singing practice by analyzing a PDF of sheet music notes and providing real-time feedback on pitch accuracy.

## Features

- Upload a PDF of sheet music (lyrics will be extracted as text).
- Input the sequence of musical notes manually (e.g., C4, D4, E4).
- Extracts lyrics text and splits into words.
- Assumes each word corresponds to a note in sequence.
- Uses microphone to listen to your singing.
- Detects pitches in real-time and compares to expected notes sequentially.
- Highlights lyrics words: green for correct, yellow for close, red for off.
- Provides feedback on sung note, expected note, and interval difference.

## Requirements

- Modern web browser with microphone access.
- PDF of sheet music with extractable lyrics text.
- Manual input of note sequence corresponding to the lyrics.

## Installation

1. Clone or download the repository.
2. Run `npm install` to install dependencies.
3. Run `npm run build` to build the app.
4. To run locally without a server: Open `dist/index.html` in your browser (may have CORS issues in some browsers).
5. For best results, serve the `dist/` folder with a local server:
   - Using Python: `cd dist && python -m http.server 8000` then open `http://localhost:8000`
   - Using Node: `npx serve dist` then open the provided URL.
6. Allow microphone access when prompted.

## Usage

1. Upload a PDF file of sheet music using the file input.
2. Enter the note sequence in the text input (comma separated, e.g., C4, D4, E4).
3. Click "Start Listening" to begin microphone access.
4. Sing the notes in sequence corresponding to the lyrics.
5. View real-time feedback and highlighted lyrics words.

## Technologies

- React
- Vite
- PDF.js for PDF text extraction
- Pitchfinder for pitch detection
- Web Audio API for microphone input
