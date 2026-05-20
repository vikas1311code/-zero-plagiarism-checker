const {
  app, BrowserWindow, clipboard, ipcMain, shell,
  dialog, Tray, Menu, nativeImage, Notification
} = require('electron');
const axios    = require('axios');
const natural  = require('natural');
const fs       = require('fs');
const path     = require('path');
const { exec } = require('child_process');
const TfIdf    = natural.TfIdf;

app.setName('ZERO');

let win, tray;
let lastClipboard   = '';
let referenceCorpus = [];
let isQuitting      = false;
let jsonHistory     = [];
let historyFile     = '';
let db              = null;

// ─── KEYS (loaded dynamically from config) ────────────────────────────────────
let SERPER_KEY    = '';
let ANTHROPIC_KEY = '';

// ─── SECURE KEY STORAGE (OS Keychain via keytar) ──────────────────────────────
// Falls back to encrypted local file if keytar is unavailable.
const KEYTAR_SERVICE = 'zero-plagiarism-checker';
let _keytarAvailable = false;

// Lazy-load keytar so the app still starts even if native module isn't built yet
function getKeytar() {
  if (_keytarAvailable) return require('keytar');
  try {
    const kt = require('keytar');
    _keytarAvailable = true;
    return kt;
  } catch {
    return null;
  }
}

// Fallback: simple XOR-obfuscated file (NOT encryption, just prevents casual reading)
let configFile = '';
const _XOR_SEED = 0x5A; // 'Z'
function xorBuf(str) {
  return Buffer.from(str).map(b => b ^ _XOR_SEED).toString('base64');
}
function unxorBuf(b64) {
  try {
    return Buffer.from(b64, 'base64').map(b => b ^ _XOR_SEED).toString();
  } catch { return ''; }
}

async function loadConfig() {
  try {
    const dataDir = app.getPath('userData');
    configFile = path.join(dataDir, 'zero-config.enc');

    const kt = getKeytar();
    if (kt) {
      // Prefer OS keychain
      SERPER_KEY    = (await kt.getPassword(KEYTAR_SERVICE, 'serperKey'))    || '';
      ANTHROPIC_KEY = (await kt.getPassword(KEYTAR_SERVICE, 'anthropicKey')) || '';
      console.log('[ZERO] Keys loaded from OS keychain — Serper:', !!SERPER_KEY, '| Anthropic:', !!ANTHROPIC_KEY);

      // Migrate old plaintext config if present
      const oldCfg = path.join(dataDir, 'zero-config.json');
      if (fs.existsSync(oldCfg)) {
        try {
          const old = JSON.parse(fs.readFileSync(oldCfg, 'utf8'));
          if (old.serperKey    && !SERPER_KEY)    { SERPER_KEY    = old.serperKey;    await kt.setPassword(KEYTAR_SERVICE, 'serperKey', SERPER_KEY); }
          if (old.anthropicKey && !ANTHROPIC_KEY) { ANTHROPIC_KEY = old.anthropicKey; await kt.setPassword(KEYTAR_SERVICE, 'anthropicKey', ANTHROPIC_KEY); }
          fs.unlinkSync(oldCfg); // remove plaintext file after migration
          console.log('[ZERO] Migrated plaintext config to OS keychain and deleted old file');
        } catch {}
      }
    } else {
      // Fallback: obfuscated file
      if (fs.existsSync(configFile)) {
        const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        SERPER_KEY    = unxorBuf(raw.s || '');
        ANTHROPIC_KEY = unxorBuf(raw.a || '');
      }
      console.log('[ZERO] keytar unavailable — using obfuscated file fallback');
    }
  } catch (e) {
    console.warn('[ZERO] Config load error:', e.message);
  }
}

async function saveConfig(serperKey, anthropicKey) {
  try {
    const kt = getKeytar();
    if (kt) {
      if (serperKey    !== null) { serperKey    ? await kt.setPassword(KEYTAR_SERVICE, 'serperKey', serperKey)       : await kt.deletePassword(KEYTAR_SERVICE, 'serperKey'); }
      if (anthropicKey !== null) { anthropicKey ? await kt.setPassword(KEYTAR_SERVICE, 'anthropicKey', anthropicKey) : await kt.deletePassword(KEYTAR_SERVICE, 'anthropicKey'); }
    } else {
      const enc = { s: xorBuf(serperKey || ''), a: xorBuf(anthropicKey || '') };
      fs.writeFileSync(configFile, JSON.stringify(enc), 'utf8');
    }
    if (serperKey    !== null) SERPER_KEY    = serperKey    || '';
    if (anthropicKey !== null) ANTHROPIC_KEY = anthropicKey || '';
    console.log('[ZERO] Config saved securely');
    return true;
  } catch (e) {
    console.error('[ZERO] Config save error:', e.message);
    return false;
  }
}

// ─── STOPWORDS ────────────────────────────────────────────────────────────────
// Extended stopword list — includes common tech/app/UI words that are
// NOT meaningful for plagiarism detection but pollute TF-IDF scores.
const SW = new Set([
  // Core English stopwords
  'is','the','and','a','an','of','to','in','it','that','with','as','for',
  'was','on','are','be','from','at','by','this','his','her','their','our',
  'we','he','she','they','i','you','my','your','have','has','had','not',
  'but','or','if','so','do','did','will','would','can','could','should',
  'may','might','about','more','also','than','then','when','where','who',
  'which','what','how','all','some','there','these','those','its','been',
  'were','into','out','up','down','just','very','really','get','got','one',
  'two','new','like','make','use','used','using','said','say','even','each',
  // Extended common words
  'want','give','go','going','come','see','look','know','think','take',
  'need','let','tell','ask','try','keep','help','show','change',
  'add','remove','open','close','click','set','run','work','put',
  'same','different','other','another','every','any','such','only','still',
  'after','before','over','through','during','without','within','between',
  'both','few','most','no','nor','own','too','because','while','although',
  'since','though','until','unless','whether','once','now','here',
  'dont','doesnt','didnt','wont','cant','shouldnt','couldnt','wouldnt',
  'im','ive','id','youre','theyre','hes','shes','weve',
  // Common tech/app words that are NOT plagiarism signals
  'api','key','app','button','feature','option','tab','menu',
  'page','screen','window','icon','text','data','file','folder','user',
  'system','list','item','type','name','value','code','version','link',
  'site','web','url','http','www','com','net','org','io',
  // Common instruction/action words that appear everywhere
  'please','write','create','build','generate','update','modify',
  'check','test','fix','correct','improve','send','save','load','read',
  'deploy','install','setup','configure',
  'enable','disable','allow','block','delete','edit','view','search'
]);

// ─── WSL HELPERS ─────────────────────────────────────────────────────────────
function isWSL() {
  try {
    const v = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
    return v.includes('microsoft') || v.includes('wsl');
  } catch { return false; }
}

function getDistro() {
  try {
    const r = fs.readFileSync('/etc/os-release', 'utf8');
    const m = r.match(/^NAME="?([^"\n]+)"?/m);
    return m ? m[1].trim() : 'Ubuntu';
  } catch { return 'Ubuntu'; }
}

function toWinPath(p) {
  return `\\\\wsl$\\${getDistro()}${p.replace(/\//g, '\\')}`;
}

function openFolderSafe(p) {
  if (isWSL()) {
    exec(`explorer.exe "${toWinPath(p)}"`, () => {});
  } else {
    shell.openPath(p);
  }
}

function openLinkSafe(url) {
  if (!url) return;

  if (isWSL()) {
    if (url.startsWith('file://')) {
      const linuxPath = url.replace('file://', '');
      const fileName  = path.basename(linuxPath);

      exec('cmd.exe /c echo %TEMP%', (err, tempRaw) => {
        if (err || !tempRaw) {
          const winPath = toWinPath(linuxPath);
          exec('explorer.exe "' + winPath + '"', () => {});
          return;
        }
        const winTemp   = tempRaw.trim().replace(/[\r\n]/g, '');
        const winDest   = winTemp + '\\' + fileName;
        const linuxTemp = winTemp
          .replace(/\\/g, '/')
          .replace(/^([A-Za-z]):/, (m, d) => '/mnt/' + d.toLowerCase());
        const linuxDest = linuxTemp + '/' + fileName;

        exec('cp "' + linuxPath + '" "' + linuxDest + '"', copyErr => {
          if (copyErr) {
            const winPath = toWinPath(linuxPath);
            exec('explorer.exe "' + winPath + '"', () => {});
            return;
          }
          const fileUrl = 'file:///' + winDest.replace(/\\/g, '/');
          exec('cmd.exe /c start chrome.exe "' + fileUrl + '"', openErr => {
            if (openErr) {
              exec('cmd.exe /c start "" "' + fileUrl + '"', () => {});
            }
          });
        });
      });
      return;
    }

    const safe = url.replace(/&/g, '^&');
    exec('cmd.exe /c start chrome.exe "' + safe + '"', err => {
      if (err) {
        exec('cmd.exe /c start "" "' + safe + '"', err2 => {
          if (err2) {
            exec('powershell.exe -Command "Start-Process \"' + url + '\"" ', () => {});
          }
        });
      }
    });

  } else {
    shell.openExternal(url);
  }
}

// ─── STORAGE ──────────────────────────────────────────────────────────────────
function initStorage() {
  const dataDir = app.getPath('userData');
  historyFile   = path.join(dataDir, 'zero-history.json');

  try {
    const Database = require('better-sqlite3');
    db = new Database(path.join(dataDir, 'zero.db'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS scans (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        text      TEXT    NOT NULL,
        score     INTEGER DEFAULT 0,
        source    TEXT    DEFAULT 'Clipboard',
        web_link  TEXT    DEFAULT '',
        web_title TEXT    DEFAULT '',
        words     INTEGER DEFAULT 0,
        type      TEXT    DEFAULT 'local',
        ts        TEXT    DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_ts ON scans(ts);
    `);
    db.ins  = db.prepare('INSERT INTO scans (text,score,source,web_link,web_title,words,type) VALUES (?,?,?,?,?,?,?)');
    db.lst  = db.prepare('SELECT * FROM scans ORDER BY ts DESC LIMIT ?');
    db.stat = db.prepare('SELECT COUNT(*) total, ROUND(AVG(score),1) avg_score, SUM(CASE WHEN score>50 THEN 1 ELSE 0 END) high_risk, SUM(CASE WHEN score<15 THEN 1 ELSE 0 END) clean FROM scans');
    db.del  = db.prepare('DELETE FROM scans');
    db.trim = db.prepare('DELETE FROM scans WHERE id NOT IN (SELECT id FROM scans ORDER BY ts DESC LIMIT 500)');
    console.log('[ZERO] SQLite ready');
    return 'sqlite';
  } catch (e) {
    console.warn('[ZERO] SQLite unavailable:', e.message);
    db = null;
  }

  try {
    if (fs.existsSync(historyFile))
      jsonHistory = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  } catch { jsonHistory = []; }
  console.log('[ZERO] JSON storage ready');
  return 'json';
}

function saveRecord(data) {
  if (db) {
    try {
      db.ins.run(
        (data.text || '').substring(0, 2000),
        data.score || 0,
        data.source || 'Clipboard',
        data.webLink  || '',
        data.webTitle || '',
        data.words    || 0,
        data.type     || 'local'
      );
      db.trim.run();
      return;
    } catch (e) { console.error('[DB]', e.message); }
  }
  const rec = {
    id: Date.now(),
    text:      (data.text || '').substring(0, 2000),
    score:     data.score    || 0,
    source:    data.source   || 'Clipboard',
    web_link:  data.webLink  || '',
    web_title: data.webTitle || '',
    words:     data.words    || 0,
    type:      data.type     || 'local',
    ts:        new Date().toLocaleString()
  };
  jsonHistory.unshift(rec);
  if (jsonHistory.length > 500) jsonHistory.length = 500;
  try { fs.writeFileSync(historyFile, JSON.stringify(jsonHistory, null, 2)); } catch {}
}

function getHistory(limit = 100) {
  if (db) { try { return db.lst.all(limit); } catch {} }
  return jsonHistory.slice(0, limit);
}

function getStats() {
  if (db) { try { return db.stat.get(); } catch {} }
  const sc = jsonHistory.map(h => h.score || 0);
  return {
    total:     jsonHistory.length,
    avg_score: sc.length ? Math.round(sc.reduce((a, b) => a + b, 0) / sc.length) : 0,
    high_risk: jsonHistory.filter(h => h.score > 50).length,
    clean:     jsonHistory.filter(h => h.score < 15).length
  };
}

function clearHistory() {
  if (db) { try { db.del.run(); return; } catch {} }
  jsonHistory = [];
  try { fs.writeFileSync(historyFile, '[]'); } catch {}
}

// ─── CORPUS ───────────────────────────────────────────────────────────────────
function loadCorpus() {
  const dir = path.join(__dirname, 'corpus');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt'));
  if (files.length === 0) createSampleCorpus(dir);

  referenceCorpus = [];
  const all = fs.readdirSync(dir).filter(f => f.endsWith('.txt'));
  for (const f of all) {
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    content.split(/\n\n+/)
      .map(p => p.trim())
      .filter(p => p.length > 20)
      .forEach(p => referenceCorpus.push(p));
  }
  console.log(`[ZERO] Corpus: ${referenceCorpus.length} paragraphs from ${all.length} files`);
  return { count: referenceCorpus.length, files: all, fileCount: all.length };
}

function createSampleCorpus(dir) {
  const samples = {
    'machine_learning.txt': `Machine learning is a method of data analysis that automates analytical model building.\n\nMachine learning algorithms are trained using large sets of data and they learn from experience. The more data these algorithms are exposed to, the better they perform.\n\nSupervised learning is a type of machine learning where the model is trained on labeled data.\n\nDeep learning uses neural networks with many layers to learn hierarchical representations of data. It has achieved remarkable results in image recognition and natural language processing.`,
    'artificial_intelligence.txt': `Artificial intelligence refers to the simulation of human intelligence in machines that are programmed to think like humans and mimic their actions.\n\nNatural language processing is a branch of artificial intelligence that deals with the interaction between computers and humans using natural language.\n\nComputer vision is a field of artificial intelligence that trains computers to interpret and understand the visual world.`,
    'plagiarism_ethics.txt': `Plagiarism is the practice of taking someone else's work or ideas and passing them off as one's own. It is considered a serious ethical violation.\n\nAcademic integrity refers to the ethical policy or moral code of academia. It includes avoidance of cheating or plagiarism.\n\nCopyright infringement occurs when a copyrighted work is reproduced without the permission of the copyright owner.`,
    'computer_science.txt': `A computer algorithm is a finite sequence of well-defined instructions used to solve a class of specific problems.\n\nData structures are a way of organizing and storing data in a computer so that it can be accessed and modified efficiently.\n\nSoftware engineering is the systematic application of engineering approaches to the development of software.`,
    'web_development.txt': `JavaScript is a scripting language that enables you to create dynamically updating content. It is a core technology of the World Wide Web.\n\nElectron.js is a framework for building cross-platform desktop applications using JavaScript, HTML, and CSS.\n\nNode.js is an open-source JavaScript runtime environment that executes JavaScript code outside a web browser.`
  };
  for (const [name, content] of Object.entries(samples)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
}

// ─── TEXT PROCESSING ──────────────────────────────────────────────────────────
function cleanText(t) {
  return t.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    // Require length > 3 (was > 2) — stops short filler words inflating TF-IDF
    .filter(w => !SW.has(w) && w.length > 3)
    .join(' ');
}

function splitSentences(text) {
  const raw = text.match(/[^.!?\n]+[.!?\n]+/g) || [text];
  return raw.map(s => s.trim()).filter(s => s.split(/\s+/).length > 3 && s.length > 15);
}

function scoreText(text) {
  if (!text || text.trim().length < 10) return 0;
  const cleaned = cleanText(text);
  // Need at least 3 meaningful words after stopword removal to produce a valid score
  if (!cleaned || cleaned.split(/\s+/).filter(Boolean).length < 3) return 0;

  const tfidf = new TfIdf();
  for (const doc of referenceCorpus) tfidf.addDocument(cleanText(doc));

  const scores = [];
  tfidf.tfidfs(cleaned, (i, m) => { scores.push(Math.max(0, m)); });
  if (!scores.length) return 0;

  const maxScore = Math.max(...scores);
  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

  // 50/50 split (was 60/40) — reduces single-doc spikes from short matching phrases
  const combined = maxScore * 0.5 + avgScore * 0.5;

  // ── RECALIBRATED SCORING CURVE ────────────────────────────────────────────
  // Root problem: original writing in a tech/AI domain naturally gets TF-IDF
  // scores of 2–5 just from shared domain vocabulary ("learning", "model",
  // "data", "language", "network") even with ZERO copying. The old curve
  // mapped combined=3 → 35% which was wrong. Corrected mapping:
  //
  //   combined 0–2   →  0– 8%  incidental word overlap (normal original writing)
  //   combined 2–5   →  8–20%  some domain vocabulary overlap (still original)
  //   combined 5–9   → 20–45%  meaningful structural similarity (borderline)
  //   combined 9–13  → 45–75%  strong match — likely copied or heavily borrowed
  //   combined 13–18 → 75–95%  very close / near-verbatim copy
  //   combined 18+   → 95–100% direct verbatim copy
  //
  // Original text in a tech domain: expect 3–12% (previously showed 25–50%)
  // Copied sentences from corpus:   expect 65–95% (unchanged, still detected)
  let score;
  if      (combined <= 0)   score = 0;
  else if (combined < 2)    score = Math.round(combined * 4);                 //  0– 8%
  else if (combined < 5)    score = Math.round(8  + (combined - 2)  * 4);    //  8–20%
  else if (combined < 9)    score = Math.round(20 + (combined - 5)  * 6.25); // 20–45%
  else if (combined < 13)   score = Math.round(45 + (combined - 9)  * 7.5);  // 45–75%
  else if (combined < 18)   score = Math.round(75 + (combined - 13) * 4);    // 75–95%
  else                      score = Math.round(95 + Math.min((combined - 18) * 1, 5)); // 95–100%

  return Math.min(Math.max(score, 0), 100);
}

function analyzeText(text) {
  const overall = scoreText(text);
  const sentences = splitSentences(text);
  const sentenceResults = sentences.map(s => ({ text: s, score: scoreText(s) }));
  return { overall, sentenceResults };
}

// ─── WRITING DNA ──────────────────────────────────────────────────────────────
function analyzeWritingDNA(text) {
  const sentences = splitSentences(text);
  const words     = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 0);
  const unique    = new Set(words);

  const avgSentLen  = sentences.length > 0 ? Math.round(words.length / sentences.length) : 0;
  const ttr         = words.length > 0 ? Math.round((unique.size / words.length) * 100) : 0;
  const passiveHits = (text.match(/\b(was|were|been|is|are|be)\s+\w+ed\b/gi) || []).length;
  const passivePct  = sentences.length > 0 ? Math.round((passiveHits / sentences.length) * 100) : 0;
  const avgWordLen  = words.length > 0
    ? Math.round((words.reduce((s, w) => s + w.length, 0) / words.length) * 10) / 10 : 0;
  const punctCount  = (text.match(/[,;:]/g) || []).length;
  const punctDensity = words.length > 0 ? Math.round((punctCount / words.length) * 100) : 0;
  const transitions  = ['however','therefore','moreover','furthermore','although',
                        'whereas','consequently','nevertheless','additionally'];
  const transPct = words.length > 0
    ? Math.round((words.filter(w => transitions.includes(w)).length / words.length) * 1000) / 10 : 0;

  const dnaScore = Math.min(100, Math.round(
    (ttr * 0.4) +
    (Math.min(avgSentLen, 30) / 30 * 30) +
    (Math.min(punctDensity, 15) / 15 * 20) +
    (Math.min(transPct, 2) / 2 * 10)
  ));

  return { avgSentLen, ttr, passivePct, avgWordLen, punctDensity, transPct,
           dnaScore, wordCount: words.length, sentenceCount: sentences.length,
           uniqueWordCount: unique.size };
}

// ─── WORD HEATMAP ─────────────────────────────────────────────────────────────
function buildHeatmap(text) {
  const tfidf = new TfIdf();
  for (const doc of referenceCorpus) tfidf.addDocument(cleanText(doc));

  return text.split(/(\s+|(?=[.!?,;:]))/).map(token => {
    const clean = token.toLowerCase().replace(/[^\w]/g, '');
    if (!clean || clean.length < 2 || SW.has(clean)) return { token, risk: 0 };
    let max = 0;
    tfidf.tfidfs(clean, (i, m) => { if (m > max) max = m; });
    const risk = max > 3 ? 3 : max > 1.5 ? 2 : max > 0.5 ? 1 : 0;
    return { token, risk, score: Math.round(max * 10) / 10 };
  });
}

// ─── PARAPHRASE DETECTOR ──────────────────────────────────────────────────────
function detectParaphrase(userText, refText) {
  if (!refText || refText.length < 10) return { score: 0, matchedKeywords: [] };
  const uw = new Set(userText.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => !SW.has(w) && w.length > 3));
  const rw = new Set(refText.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => !SW.has(w) && w.length > 3));
  const matched   = [...uw].filter(w => rw.has(w));
  const union     = new Set([...uw, ...rw]).size;
  const jaccard   = union > 0 ? Math.round((matched.length / union) * 100) : 0;
  const uStems    = new Set([...uw].map(w => w.substring(0, 5)));
  const rStems    = new Set([...rw].map(w => w.substring(0, 5)));
  const stemBonus = Math.min(20, [...uStems].filter(s => rStems.has(s) && s.length >= 4).length * 2);
  return { score: Math.min(100, jaccard + stemBonus), matchedKeywords: matched.slice(0, 12) };
}

// ─── CITATION GENERATOR ───────────────────────────────────────────────────────
function generateCitations(link, title) {
  if (!link) return null;
  const now   = new Date();
  const year  = now.getFullYear();
  const months = ['January','February','March','April','May','June','July',
                  'August','September','October','November','December'];
  const month = months[now.getMonth()];
  const day   = now.getDate();
  let domain  = '';
  try { domain = new URL(link).hostname.replace('www.', ''); } catch {}
  const t = title || 'Untitled Page';
  return {
    apa:     `Author, A. (${year}). ${t}. ${domain}. Retrieved ${month} ${day}, ${year}, from ${link}`,
    mla:     `"${t}." ${domain}, ${year}, ${link}. Accessed ${day} ${month} ${year}.`,
    chicago: `"${t}." ${domain}. Last modified ${year}. ${link}.`
  };
}

// ─── ORIGINALITY TIMELINE ─────────────────────────────────────────────────────
function buildTimeline(text) {
  return splitSentences(text).map((s, i) => ({
    index: i,
    text:  s.substring(0, 70) + (s.length > 70 ? '…' : ''),
    score: scoreText(s)
  }));
}

// ─── AI REWRITE ───────────────────────────────────────────────────────────────
const SYN = {
  'shows':'demonstrates','important':'significant','many':'numerous',
  'uses':'employs','helps':'facilitates','makes':'creates','large':'substantial',
  'small':'minimal','good':'effective','bad':'problematic','new':'novel',
  'old':'established','known':'recognized','often':'frequently',
  'usually':'typically','because':'since','however':'nevertheless',
  'also':'additionally','but':'yet','so':'therefore','very':'particularly',
  'get':'obtain','give':'provide','use':'utilize','show':'illustrate',
  'find':'identify','need':'require','start':'initiate','end':'conclude',
  'about':'regarding','change':'modify','fast':'rapid','slow':'gradual',
  'easy':'straightforward','hard':'challenging'
};

function ruleRewrite(sentence) {
  const words = sentence.trim().split(/\s+/);
  if (words.length < 4) return sentence;
  let changed = false;
  const out = words.map(w => {
    const lower = w.toLowerCase().replace(/[^a-z]/g, '');
    const syn   = SYN[lower];
    if (!syn) return w;
    changed = true;
    const isCapital = w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase();
    return isCapital ? syn.charAt(0).toUpperCase() + syn.slice(1) : syn;
  });
  if (changed) return out.join(' ');
  return `In other words, ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
}

async function getAIRewrite(sentence) {
  if (ANTHROPIC_KEY) {
    try {
      const res = await axios.post('https://api.anthropic.com/v1/messages', {
        model:      'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages:   [{ role: 'user', content: `Rewrite this sentence to be completely original while keeping the same meaning. Return ONLY the rewritten sentence, nothing else.\n\nOriginal: "${sentence}"` }]
      }, {
        headers: {
          'x-api-key':         ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type':      'application/json'
        }
      });
      return res.data.content[0]?.text?.trim() || ruleRewrite(sentence);
    } catch (e) { console.error('[AI]', e.message); }
  }
  return ruleRewrite(sentence);
}

// ─── FILE SCANNING ────────────────────────────────────────────────────────────
async function extractPDF(fp) {
  try {
    const pdf  = require('pdf-parse');
    const data = await pdf(fs.readFileSync(fp));
    return { text: data.text, pages: data.numpages };
  } catch (e) {
    return new Promise(res => exec(`pdftotext "${fp}" -`, (err, out) =>
      res(err || !out.trim() ? { text: '', pages: 0 } : { text: out, pages: 0 })
    ));
  }
}

async function extractDOCX(fp) {
  try {
    const mammoth = require('mammoth');
    const result  = await mammoth.extractRawText({ path: fp });
    return { text: result.value };
  } catch (e) { return { text: '' }; }
}

async function scanFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let extracted;
  if      (ext === '.pdf')               extracted = await extractPDF(filePath);
  else if (ext === '.docx' || ext === '.doc') extracted = await extractDOCX(filePath);
  else if (ext === '.txt')               extracted = { text: fs.readFileSync(filePath, 'utf8'), pages: 1 };
  else return { error: 'Unsupported file type. Use PDF, DOCX or TXT.' };

  if (!extracted.text || extracted.text.trim().length < 20)
    return { error: 'Could not extract text from file. It may be a scanned/image PDF.' };

  const { overall, sentenceResults } = analyzeText(extracted.text);
  const words = extracted.text.trim().split(/\s+/).length;
  const dna   = analyzeWritingDNA(extracted.text);
  const timeline = buildTimeline(extracted.text);

  saveRecord({ text: extracted.text, score: overall, source: path.basename(filePath), words, type: 'file' });

  return {
    score: overall, text: extracted.text,
    fileName: path.basename(filePath),
    fileType: ext.replace('.', '').toUpperCase(),
    pages:    extracted.pages || '–',
    wordCount: words, sentenceResults, dna, timeline
  };
}

async function batchScan(folderPath) {
  const exts  = ['.pdf', '.docx', '.txt'];
  const files = fs.readdirSync(folderPath).filter(f => exts.includes(path.extname(f).toLowerCase()));
  const results = [];
  for (const f of files) {
    const r = await scanFile(path.join(folderPath, f));
    results.push({ file: f, ...r });
  }
  return results.sort((a, b) => (b.score || 0) - (a.score || 0));
}

// ─── WEB SCAN ─────────────────────────────────────────────────────────────────
async function webScan(text) {
  if (!SERPER_KEY) return { score: 0, link: '', snippet: '', sentenceResults: [], noKey: true };
  try {
    const res = await axios.post(
      'https://google.serper.dev/search',
      { q: text.substring(0, 120) },
      { headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' } }
    );
    const top = res.data.organic?.[0];
    if (!top) return { score: 0, link: '', snippet: '', sentenceResults: [] };

    const snippet = top.snippet || '';
    const tfidf   = new TfIdf();
    tfidf.addDocument(snippet.toLowerCase());
    let sim = 0;
    tfidf.tfidfs(text.toLowerCase(), (i, m) => { sim = m; });

    const sentenceResults = splitSentences(text).map(s => {
      const st = new TfIdf();
      st.addDocument(snippet.toLowerCase());
      let ss = 0;
      st.tfidfs(s.toLowerCase(), (i, m) => { ss = m; });
      return { text: s, score: Math.min(Math.round(ss * 45), 100) };
    });

    const allResults = (res.data.organic || []).slice(0, 3).map(r => ({
      title: r.title || '', link: r.link || '', snippet: r.snippet || ''
    }));

    return {
      score: Math.min(Math.round(sim * 45), 100),
      link:  top.link,
      title: top.title || '',
      snippet,
      sentenceResults,
      allResults
    };
  } catch (e) {
    console.error('[WEB]', e.message);
    return { score: 0, link: '', snippet: '', sentenceResults: [] };
  }
}

// ─── HTML REPORT ──────────────────────────────────────────────────────────────
function esc(t) {
  return String(t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateReport(data) {
  const { text, score, sentenceResults, fileName, webLink, webTitle, webSnippet,
          scanTime, localScore, dna, citations } = data;
  const c = score > 50 ? '#ff3d5a' : score > 15 ? '#ffb020' : '#00e096';
  const l = score > 50 ? 'HIGH RISK' : score > 15 ? 'MODERATE' : 'CLEAN';

  const rows = (sentenceResults || []).map(s => {
    const sc = s.score > 50 ? '#ff3d5a' : s.score > 15 ? '#ffb020' : '#00e096';
    const bg = s.score > 50 ? 'rgba(255,61,90,.08)' : s.score > 15 ? 'rgba(255,176,32,.08)' : 'rgba(0,224,150,.06)';
    return `<tr><td style="padding:9px 14px;font-size:13px;color:#ccc;border-bottom:1px solid #1e1e30;background:${bg}">${esc(s.text)}</td><td style="padding:9px 14px;font-size:13px;font-weight:700;color:${sc};border-bottom:1px solid #1e1e30;text-align:center;background:${bg}">${s.score}%</td></tr>`;
  }).join('');

  const compareBlock = (localScore !== undefined && localScore !== score) ? `
    <h2>Before vs After Web Scan</h2>
    <div style="display:flex;gap:14px;margin-bottom:28px">
      <div style="flex:1;background:#161624;border:1px solid #1e1e30;border-radius:12px;padding:18px;text-align:center">
        <div style="font-size:11px;color:#555;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px">Local Score</div>
        <div style="font-size:2.5rem;font-weight:800;color:${localScore>50?'#ff3d5a':localScore>15?'#ffb020':'#00e096'}">${localScore}%</div>
      </div>
      <div style="flex:1;background:#161624;border:1px solid #1e1e30;border-radius:12px;padding:18px;text-align:center">
        <div style="font-size:11px;color:#555;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px">Web Score</div>
        <div style="font-size:2.5rem;font-weight:800;color:${c}">${score}%</div>
      </div>
    </div>` : '';

  const dnaBlock = dna ? `
    <h2>Writing DNA Fingerprint</h2>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:28px">
      ${[['DNA Score', dna.dnaScore+'%'], ['Vocab Richness', dna.ttr+'%'],
         ['Avg Sent Length', dna.avgSentLen+' words'], ['Passive Voice', dna.passivePct+'%'],
         ['Avg Word Length', dna.avgWordLen], ['Transition Words', dna.transPct+'%']
        ].map(([label, val]) => `<div style="background:#161624;border:1px solid #1e1e30;border-radius:10px;padding:13px"><div style="font-size:11px;color:#555;letter-spacing:1px;text-transform:uppercase;margin-bottom:5px">${label}</div><div style="font-size:18px;font-weight:700;color:#e0e0f0">${val}</div></div>`).join('')}
    </div>` : '';

  const citeBlock = citations ? `
    <h2>Auto-Generated Citations</h2>
    <div style="background:#161624;border:1px solid #1e1e30;border-radius:12px;padding:18px;margin-bottom:28px">
      <div style="font-size:11px;color:#555;letter-spacing:1px;text-transform:uppercase;margin-bottom:7px">APA 7th</div>
      <div style="font-size:13px;color:#aaa;margin-bottom:16px;line-height:1.7">${esc(citations.apa)}</div>
      <div style="font-size:11px;color:#555;letter-spacing:1px;text-transform:uppercase;margin-bottom:7px">MLA 9th</div>
      <div style="font-size:13px;color:#aaa;margin-bottom:16px;line-height:1.7">${esc(citations.mla)}</div>
      <div style="font-size:11px;color:#555;letter-spacing:1px;text-transform:uppercase;margin-bottom:7px">Chicago</div>
      <div style="font-size:13px;color:#aaa;line-height:1.7">${esc(citations.chicago)}</div>
    </div>` : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>ZERO Report</title>
<style>
body{font-family:'Segoe UI',sans-serif;background:#080810;color:#e0e0f0;margin:0;padding:36px;max-width:900px;margin:0 auto}
h1{font-size:28px;font-weight:800;margin-bottom:4px}
.sub{color:#444;font-size:13px;margin-bottom:36px}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:32px}
.mc{background:#161624;border:1px solid #1e1e30;border-radius:12px;padding:16px}
.ml{font-size:11px;color:#555;letter-spacing:1px;text-transform:uppercase;margin-bottom:7px}
.mv{font-size:24px;font-weight:800}
h2{font-size:14px;font-weight:700;color:#555;letter-spacing:1.5px;text-transform:uppercase;margin:32px 0 14px;border-bottom:1px solid #1e1e30;padding-bottom:8px}
table{width:100%;border-collapse:collapse;background:#0f0f1a;border-radius:12px;overflow:hidden}
.prev{background:#0f0f1a;border:1px solid #1e1e30;border-radius:12px;padding:18px;font-size:13px;line-height:1.9;color:#888;white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto}
.src{background:#0d1a2e;border:1px solid rgba(77,143,255,.2);border-radius:12px;padding:16px;margin-bottom:28px}
.src a{color:#4d8fff;word-break:break-all}
footer{margin-top:48px;font-size:11px;color:#222;text-align:center;padding-bottom:32px}
.zero{font-weight:800;letter-spacing:3px;color:#7c6aff}
</style></head><body>
<div class="zero">ZERO</div>
<h1>Plagiarism Report</h1>
<div class="sub">${esc(scanTime || new Date().toLocaleString())}</div>
<div class="meta">
  <div class="mc"><div class="ml">Score</div><div class="mv" style="color:${c}">${score}%</div><div style="font-size:12px;color:${c};margin-top:5px;font-weight:700">${l}</div></div>
  <div class="mc"><div class="ml">Source</div><div class="mv" style="font-size:15px">${esc(fileName || 'Clipboard')}</div></div>
  <div class="mc"><div class="ml">Words</div><div class="mv">${(text || '').trim().split(/\s+/).length}</div></div>
  <div class="mc"><div class="ml">Sentences</div><div class="mv">${(sentenceResults || []).length}</div></div>
  <div class="mc"><div class="ml">High Risk</div><div class="mv" style="color:#ff3d5a">${(sentenceResults || []).filter(s => s.score > 50).length}</div></div>
</div>
${compareBlock}${dnaBlock}${citeBlock}
${webLink ? `<div class="src"><div style="font-size:11px;color:#555;letter-spacing:1px;text-transform:uppercase;margin-bottom:7px">Matched Source</div><div style="font-size:15px;font-weight:600;margin-bottom:6px">${esc(webTitle || '')}</div><a href="${esc(webLink)}">${esc(webLink)}</a>${webSnippet ? `<div style="font-size:12px;color:#555;margin-top:9px;font-style:italic;line-height:1.7">${esc(webSnippet)}</div>` : ''}</div>` : ''}
<h2>Sentence Analysis</h2>
<table><thead><tr><th style="padding:11px 14px;text-align:left;font-size:11px;color:#555;border-bottom:1px solid #1e1e30;background:#080810">Sentence</th><th style="padding:11px 14px;text-align:center;font-size:11px;color:#555;border-bottom:1px solid #1e1e30;background:#080810;width:90px">Score</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Full Text</h2>
<div class="prev">${esc((text || '').substring(0, 3000))}${(text || '').length > 3000 ? '\n\n[truncated…]' : ''}</div>
<footer><span class="zero">ZERO</span> — Advanced Plagiarism Detection · ${new Date().getFullYear()}</footer>
</body></html>`;
}

// ─── TRAY ─────────────────────────────────────────────────────────────────────
function setupTray() {
  try {
    tray = new Tray(nativeImage.createEmpty());
    refreshTrayMenu(0, 'Ready');
    tray.setToolTip('ZERO — Plagiarism Checker');
    tray.on('click', () => {
      if (win) win.isVisible() ? win.hide() : (win.show(), win.focus());
    });
  } catch (e) { console.warn('[TRAY]', e.message); }
}

function refreshTrayMenu(score, status) {
  if (!tray) return;
  const s = getStats();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'ZERO — Plagiarism Checker', enabled: false },
    { label: `Last: ${score}% — ${status}`, enabled: false },
    { type: 'separator' },
    { label: `Scans: ${s.total || 0}  ·  Avg: ${s.avg_score || 0}%`, enabled: false },
    { type: 'separator' },
    { label: 'Show / Hide', click: () => { if (win) win.isVisible() ? win.hide() : (win.show(), win.focus()); } },
    { label: 'Clear History', click: () => { clearHistory(); win?.webContents.send('history-cleared'); } },
    { type: 'separator' },
    { label: 'Quit ZERO', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.setToolTip(`ZERO · ${score}% · ${s.total || 0} scans`);
}

// ─── WINDOW ───────────────────────────────────────────────────────────────────
async function createWindow() {
  await loadConfig(); // ← load API keys securely before anything else

  const corpusInfo  = loadCorpus();
  const storageType = initStorage();

  win = new BrowserWindow({
    width: 460, height: 880, x: 0, y: 20,
    alwaysOnTop:  true,
    frame:        false,
    transparent:  true,
    title:        'ZERO',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox:          false,
      preload:          path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile('index.html');

  win.webContents.once('did-finish-load', () => {
    win.webContents.send('app-ready', {
      corpusCount:   corpusInfo.count,
      corpusFiles:   corpusInfo.files,
      corpusFileCount: corpusInfo.fileCount,
      storageType,
      dbEnabled:     !!db,
      stats:         getStats(),
      history:       getHistory(100),
      hasAI:         !!ANTHROPIC_KEY,
      hasSerper:     !!SERPER_KEY,
      // Send masked key hints so UI can show "configured" state
      serperConfigured:    !!SERPER_KEY,
      anthropicConfigured: !!ANTHROPIC_KEY
    });
  });

  win.on('close', e => {
    if (!isQuitting && tray) { e.preventDefault(); win.hide(); }
  });

  // ── Restore saved window position ──
  try {
    const posFile = path.join(app.getPath('userData'), 'zero-winpos.json');
    if (fs.existsSync(posFile)) {
      const { x, y, width, height } = JSON.parse(fs.readFileSync(posFile, 'utf8'));
      if (Number.isInteger(x) && Number.isInteger(y)) win.setPosition(x, y);
      if (Number.isInteger(width) && Number.isInteger(height)) win.setSize(width, height);
    }
  } catch {}

  // Save position on move/resize
  const savePosDebounced = (() => {
    let t; return () => {
      clearTimeout(t);
      t = setTimeout(() => {
        try {
          const [x, y] = win.getPosition();
          const [width, height] = win.getSize();
          fs.writeFileSync(path.join(app.getPath('userData'), 'zero-winpos.json'), JSON.stringify({ x, y, width, height }));
        } catch {}
      }, 600);
    };
  })();
  win.on('moved',   savePosDebounced);
  win.on('resized', savePosDebounced);

  // ── Clipboard watcher — 4s polling is battery-friendly ──
  setInterval(() => {
    try {
      const text = clipboard.readText();
      if (!text || text.trim().length < 20 || text === lastClipboard) return;
      const trimmed = text.trim();

      if (trimmed.startsWith('{') || trimmed.startsWith('[')) return;
      if (trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      if (trimmed.startsWith('const ') || trimmed.startsWith('function ')
       || trimmed.startsWith('var ') || trimmed.startsWith('let ')
       || trimmed.startsWith('import ') || trimmed.startsWith('require(')) return;
      const lines = trimmed.split('\n');
      const codeLines = lines.filter(l => /[{}();=><]/.test(l)).length;
      if (lines.length > 3 && codeLines / lines.length > 0.4) return;

      lastClipboard = text;

      const { overall, sentenceResults } = analyzeText(text);
      const dna      = analyzeWritingDNA(text);
      const heatmap  = buildHeatmap(text);
      const timeline = buildTimeline(text);

      saveRecord({
        text, score: overall, source: 'Clipboard',
        words: text.trim().split(/\s+/).length, type: 'local'
      });

      win.webContents.send('clipboard-update', {
        text, score: overall, sentenceResults, dna, heatmap, timeline
      });

      const status = overall > 50 ? 'HIGH RISK' : overall > 15 ? 'MODERATE' : 'CLEAN';
      refreshTrayMenu(overall, status);

      if (overall > 50) {
        try {
          if (Notification.isSupported())
            new Notification({
              title: `ZERO — HIGH RISK (${overall}%)`,
              body:  text.substring(0, 80) + '…',
              silent: false
            }).show();
        } catch {}
      }
    } catch (e) { console.error('[CLIPBOARD]', e.message); }
  }, 4000);
}

// ─── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.handle('web-scan', async (e, text) => {
  const result = await webScan(text);
  if (result.noKey) return result; // propagate noKey flag
  if (result.score > 0 || result.link) {
    result.paraphrase  = detectParaphrase(text, result.snippet || '');
    result.citations   = generateCitations(result.link, result.title);
    saveRecord({
      text, score: result.score, source: 'Clipboard',
      webLink: result.link, webTitle: result.title,
      words: text.trim().split(/\s+/).length, type: 'web'
    });
    refreshTrayMenu(result.score, result.score > 50 ? 'HIGH RISK' : result.score > 15 ? 'MODERATE' : 'CLEAN');
  }
  return result;
});

// ─── NEW: API KEY IPC ─────────────────────────────────────────────────────────
ipcMain.handle('get-api-keys', () => ({
  serperConfigured:    !!SERPER_KEY,
  anthropicConfigured: !!ANTHROPIC_KEY,
  // Return masked versions for display (last 4 chars)
  serperMasked:    SERPER_KEY    ? '••••••••' + SERPER_KEY.slice(-4)    : '',
  anthropicMasked: ANTHROPIC_KEY ? '••••••••' + ANTHROPIC_KEY.slice(-4) : ''
}));

ipcMain.handle('save-api-keys', async (e, { serperKey, anthropicKey }) => {
  const ok = await saveConfig(serperKey, anthropicKey);
  // Notify renderer of updated key state
  win?.webContents.send('keys-updated', {
    hasAI:               !!ANTHROPIC_KEY,
    hasSerper:           !!SERPER_KEY,
    serperConfigured:    !!SERPER_KEY,
    anthropicConfigured: !!ANTHROPIC_KEY
  });
  return { ok };
});

ipcMain.handle('clear-api-keys', async () => {
  const ok = await saveConfig('', '');
  win?.webContents.send('keys-updated', {
    hasAI: false, hasSerper: false,
    serperConfigured: false, anthropicConfigured: false
  });
  return { ok };
});
// ─────────────────────────────────────────────────────────────────────────────

ipcMain.handle('ai-rewrite',       async (e, s)       => getAIRewrite(s));
ipcMain.handle('get-heatmap',      (e, text)           => buildHeatmap(text));
ipcMain.handle('get-dna',          (e, text)           => analyzeWritingDNA(text));
ipcMain.handle('get-timeline',     (e, text)           => buildTimeline(text));
ipcMain.handle('get-citations',    (e, link, title)    => generateCitations(link, title));
ipcMain.handle('get-paraphrase',   (e, t1, t2)         => detectParaphrase(t1, t2));
ipcMain.handle('scan-file',        async (e, p)        => scanFile(p));
ipcMain.handle('batch-scan',       async (e, p)        => batchScan(p));
ipcMain.handle('get-history',      (e, l)              => getHistory(l || 100));
ipcMain.handle('get-stats',        ()                  => getStats());
ipcMain.handle('clear-history',    ()                  => { clearHistory(); return true; });

ipcMain.handle('export-report', async (e, data) => {
  const html = generateReport(data);
  const { filePath, canceled } = await dialog.showSaveDialog(win, {
    title: 'Save ZERO Report',
    defaultPath: `zero-report-${Date.now()}.html`,
    filters: [{ name: 'HTML Report', extensions: ['html'] }]
  });
  if (canceled || !filePath) return { saved: false };
  fs.writeFileSync(filePath, html, 'utf8');
  openLinkSafe('file://' + filePath);
  return { saved: true };
});

ipcMain.handle('open-file-dialog', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(win, {
    title: 'ZERO — Select file',
    filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'doc', 'txt'] }],
    properties: ['openFile']
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('open-folder-dialog', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(win, {
    title: 'ZERO — Select folder',
    properties: ['openDirectory']
  });
  return canceled ? null : filePaths[0];
});

ipcMain.on('open-link',     (e, url) => openLinkSafe(url));
ipcMain.on('open-corpus',   ()       => openFolderSafe(path.join(__dirname, 'corpus')));
ipcMain.on('minimize',      ()       => win?.minimize());
ipcMain.on('hide-tray',     ()       => win?.hide());
ipcMain.on('quit',          ()       => { isQuitting = true; app.quit(); });
ipcMain.on('reload-corpus', ()       => {
  const info = loadCorpus();
  win?.webContents.send('corpus-updated', {
    count: info.count, files: info.files, fileCount: info.fileCount
  });
});

// ─── APP LIFECYCLE ────────────────────────────────────────────────────────────
app.whenReady().then(() => { createWindow(); setupTray(); });
app.on('window-all-closed', e => { if (!isQuitting) e.preventDefault(); });
app.on('before-quit', () => {
  isQuitting = true;
  if (db) { try { db.close(); } catch {} }
});
app.on('activate', () => { if (win) { win.show(); win.focus(); } });
