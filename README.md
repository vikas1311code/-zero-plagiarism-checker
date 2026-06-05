# ZERO — Advanced Plagiarism Detection System

A cross-platform desktop application for detecting plagiarism in academic documents using NLP-based text analysis.


## Features

- Supports **PDF** and **DOCX** file formats
- **NLP-based** text similarity detection
- Corpus-driven comparison engine
- **SQLite** database for report persistence
- Detailed plagiarism reports with similarity scores
- ️ Clean and modern desktop UI
- Available as Windows installer (.exe)

## ️ Tech Stack

- **Framework:** Electron.js
- **Frontend:** HTML, CSS, JavaScript
- **NLP:** natural (Node.js NLP library)
- **Database:** SQLite (better-sqlite3)
- **File Parsing:** pdf-parse, mammoth
- **Build:** electron-builder

## Project Structure

```
zero/
├── main.js     # Electron main process
├── index.html    # App UI
├── package.json
└── corpus/     # Reference text corpus
  ├── artificial_intelligence.txt
  ├── computer_science.txt
  ├── machine_learning.txt
  ├── plagiarism_and_ethics.txt
  └── web_development.txt
```

## ️ Installation

### Run from source

```bash
# Clone the repository
git clone https://github.com/vikas1311code/-zero-plagiarism-checker.git

# Navigate to project directory
cd -zero-plagiarism-checker

# Install dependencies
npm install

# Start the app
npm start
```

### Windows Installer
Download the latest `.exe` from the [Releases](https://github.com/vikas1311code/-zero-plagiarism-checker/releases) section.

## How It Works

1. User uploads a PDF or DOCX document
2. App extracts text using pdf-parse or mammoth
3. NLP engine compares text against the corpus
4. Similarity scores are calculated and displayed
5. Report is saved to SQLite database

## ‍ Author

**Vikas Pandey** 
B.Tech CSE — IIIT Manipur 
[GitHub](https://github.com/vikas1311code) | [Email](mailto:vikaspandey131118@gmail.com)
update
update
update
Wed Jun  3 13:12:38 UTC 2026
update
update
update
update
update
update
update
