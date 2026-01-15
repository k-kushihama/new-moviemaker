/**
 * SnapTrack Sovereign Engine v35.0 (Absolute Stability Edition)
 * Optimized for Proxmox LXC | Zero-Cost 80MB Bypass
 * SnapLynk Co., Ltd. Professional Standard
 */

const express = require('express');
const multer = require('multer');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const compression = require('compression');

const app = express();
const port = 6011;

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const PUBLIC = path.join(DATA, 'public');

[DATA, UPLOADS, PUBLIC].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try { fs.chmodSync(dir, '0777'); } catch(e) {}
});

app.use(compression());
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

app.use('/stream', (req, res, next) => {
    res.set({ 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    next();
}, express.static(PUBLIC));

const upload = multer({ dest: UPLOADS });

app.use((req, res, next) => {
    res.header('Cross-Origin-Embedder-Policy', 'require-corp');
    res.header('Cross-Origin-Opener-Policy', 'same-origin');
    next();
});

let jobs = {};

const toSec = (t) => {
    if (!t || !t.includes(':')) return 0;
    const a = t.split(':');
    return (+a[0]) * 3600 + (+a[1]) * 60 + (+a[2]);
};

// チャンクアップロード（80MB対応）
app.post('/upload-chunk', upload.single('chunk'), (req, res) => {
    const { filename, chunkIndex } = req.body;
    const chunkPath = req.file.path;
    const targetPath = path.join(UPLOADS, filename);
    if (parseInt(chunkIndex) === 0 && fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    fs.appendFileSync(targetPath, fs.readFileSync(chunkPath));
    fs.unlinkSync(chunkPath);
    res.json({ success: true });
});

app.get('/file-info/:filename', (req, res) => {
    const filePath = path.join(PUBLIC, req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not Found');
    res.json({ size: fs.statSync(filePath).size });
});

app.get('/download-seg/:filename/:start/:end', (req, res) => {
    const filePath = path.join(PUBLIC, req.params.filename);
    const start = parseInt(req.params.start);
    const end = parseInt(req.params.end);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not Found');
    res.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(filePath, { start, end }).pipe(res);
});

// レンダリングコア
app.post('/process', (req, res) => {
    const { mode, videoName, audioName, imageName, wm, x, y, fontsize, color, start, end, fadeIn, fadeOut, title, tx, ty, tfs } = req.body;
    const vPath = mode === 'video' ? path.join(UPLOADS, videoName) : null;
    const iPath = mode === 'music' ? path.join(UPLOADS, imageName) : null;
    const aPath = path.join(UPLOADS, audioName);
    const id = Date.now().toString();
    const outName = `master_${id}.mp4`;
    const outPath = path.join(PUBLIC, outName);

    // 常に progress, eta が存在するように初期化
    jobs[id] = { progress: 0, eta: 0, status: 'initializing', url: '' };

    let clipDuration = 30;
    try {
        const durData = execSync(`/usr/bin/ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${aPath}"`);
        clipDuration = parseFloat(durData.toString()) || 30;
    } catch (e) { console.error("FFprobe Error", e); }

    const sTime = parseFloat(start) || 0;
    const eTime = (parseFloat(end) > 0) ? parseFloat(end) : clipDuration;
    const finalDuration = Math.max(eTime - sTime, 1);
    const fIn = parseFloat(fadeIn) || 0;
    const fOut = parseFloat(fadeOut) || 0;
    const font = '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc';

    let filterComplex = "";
    if (mode === 'music') {
        filterComplex = `[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,boxblur=40:5,eq=brightness=0.3[bg];` +
                        `[0:v]scale=560:560:force_original_aspect_ratio=decrease[fg];` +
                        `[bg][fg]overlay=(W*0.18):(H-h)/2[v_base];`;
    } else {
        filterComplex = `[0:v]scale=-2:720:flags=fast_bilinear[v_base];`;
    }

    let textFilters = `[v_base]drawtext=fontfile='${font}':text='${wm}':x=(w*${x/100}-tw/2):y=(h*${y/100}-th/2):fontsize=${fontsize}:fontcolor=${color}:shadowcolor=black@0.5:shadowx=2:shadowy=2`;
    if (title) {
        textFilters += `,drawtext=fontfile='${font}':text='${title}':x=(w*${tx/100}-tw/2):y=(h*${ty/100}-th/2):fontsize=${tfs}:fontcolor=white:shadowcolor=black@0.5:shadowx=2:shadowy=2:text_align=center`;
    }
    
    if (fIn > 0) textFilters += `,fade=t=in:st=0:d=${fIn}`;
    if (fOut > 0) textFilters += `,fade=t=out:st=${finalDuration - fOut}:d=${fOut}`;
    textFilters += `[v_final]`;

    let aF = `volume=2.0,aresample=44100`;
    if (fIn > 0) aF += `,afade=t=in:st=0:d=${fIn}`;
    if (fOut > 0) aF += `,afade=t=out:st=${finalDuration - fOut}:d=${fOut}`;

    let args = ['-nostdin', '-y', '-threads', '8'];
    if (mode === 'music') args.push('-loop', '1');
    if (sTime > 0) args.push('-ss', sTime.toString());
    
    args.push('-i', mode === 'music' ? iPath : vPath, '-i', aPath);
    args.push('-to', finalDuration.toString());
    args.push('-filter_complex', filterComplex + textFilters, '-map', '[v_final]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '28', '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', outPath);

    const ffmpeg = spawn('/usr/bin/ffmpeg', args);
    const startTs = Date.now();
    
    // オブジェクトの一部のみを更新
    jobs[id].status = 'rendering';

    ffmpeg.stderr.on('data', d => {
        const m = d.toString().match(/time=(\d{2}:\d{2}:\d{2}.\d{2})/);
        if (m) {
            const cur = toSec(m[1]);
            const prog = Math.min(cur / finalDuration, 0.99);
            const elap = (Date.now() - startTs) / 1000;
            
            jobs[id].progress = Math.round(prog * 100);
            jobs[id].eta = prog > 0.05 ? Math.round((elap / prog) - elap) : 0;
            jobs[id].status = 'rendering';
        }
    });

    ffmpeg.on('close', code => {
        if (code === 0) {
            jobs[id].progress = 100;
            jobs[id].status = 'completed';
            jobs[id].url = `/stream/${outName}`;
        } else {
            jobs[id].status = 'error';
        }
        [vPath, iPath, aPath].forEach(p => p && fs.existsSync(p) && fs.unlinkSync(p));
    });

    res.json({ jobId: id });
});

app.get('/progress/:id', (req, res) => res.json(jobs[req.params.id] || { status: 'not_found', progress: 0, eta: 0 }));

app.listen(port, '0.0.0.0', () => {
    console.log(`\x1b[36m%s\x1b[0m`, `SnapTrack Sovereign v35.0 Stable Edition Online`);
});