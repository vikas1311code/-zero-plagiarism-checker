# ZERO — Plagiarism Detection System

> A cross-platform desktop app for detecting plagiarism in academic documents using NLP-based text analysis.

**90%+ accuracy · 100+ downloads · PDF & DOCX support · Windows .exe**

---

##  Features

- 📄 Supports **PDF** and **DOCX** file formats
- 🧠 **NLP-based** corpus comparison engine
- 📊 Detailed similarity reports with percentage scores
- 🗄️ **SQLite** database for persistent report history
- 🖥️ Clean desktop UI with system tray support
- 📦 Distributable as a Windows `.exe` installer

---

##  Tech Stack

| Layer | Technology |
|---|---|
| Framework | Electron.js |
| UI | HTML, CSS, JavaScript |
| NLP Engine | `natural` (Node.js NLP library) |
| File Parsing | `pdf-parse` (PDF), `mammoth` (DOCX) |
| Database | SQLite via `better-sqlite3` |
| Build/Packaging | `electron-builder` |

---

##  How It Works

```
User uploads PDF / DOCX
        ↓
Text extraction (pdf-parse / mammoth)
        ↓
NLP engine compares against corpus
        ↓
Similarity scores calculated per section
        ↓
Report generated & saved to SQLite
```

The corpus covers: Artificial Intelligence · Computer Science · Machine Learning · Web Development · Plagiarism & Ethics

---

##  Project Structure

```
zero/
├── main.js          # Electron main process
├── preload.js       # Secure context bridge
├── index.html       # App UI
├── corpus/          # Reference text corpus
│   ├── artificial_intelligence.txt
│   ├── computer_science.txt
│   ├── machine_learning.txt
│   ├── plagiarism_and_ethics.txt
│   └── web_development.txt
└── package.json
```

---

##  Getting Started

### Run from source

```bash
git clone https://github.com/vikas1311code/-zero-plagiarism-checker.git
cd -zero-plagiarism-checker
npm install
npm start
```

### Windows Installer

Download the latest `.exe` from the [Releases](https://github.com/vikas1311code/-zero-plagiarism-checker/releases) page — no setup required.

---

##  Author

**Vikas Pandey** — B.Tech CSE, IIIT Manipur  
[GitHub](https://github.com/vikas1311code) · [Email](mailto:vikaspandey131118@gmail.com) · [LinkedIn](https://linkedin.com/in/vikas-pandey-306792411)
update
update
update
