/**
 * SnapTrack Sovereign Engine v27.0 (Chunked Upload Edition)
 * Optimized for Proxmox LXC | Bypass Cloudflare 100MB Limit
 * SnapTrack Co., Ltd. Professional Standard
 */

const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

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

const upload = multer({ dest: UPLOADS });

app.use(express.static(path.join(ROOT, 'public')));
app.use('/stream', express.static(PUBLIC));
app.use(express.json());

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

// チャンクを受け取ってファイルに追記するエンドポイント
app.post('/upload-chunk', upload.single('chunk'), (req, res) => {
    const { filename, chunkIndex } = req.body;
    const chunkPath = req.file.path;
    const targetPath = path.join(UPLOADS, filename);

    // 最初のチャンクなら新規作成、それ以外なら追記
    if (parseInt(chunkIndex) === 0 && fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
    }

    const data = fs.readFileSync(chunkPath);
    fs.appendFileSync(targetPath, data);
    fs.unlinkSync(chunkPath); // 一時チャンクを削除

    res.json({ success: true });
});

// レンダリング開始エンドポイント
app.post('/process', (req, res) => {
    const { videoName, audioName, wm, x, y, fontsize, color, start, end } = req.body;
    const vPath = path.join(UPLOADS, videoName);
    const aPath = path.join(UPLOADS, audioName);

    if (!fs.existsSync(vPath) || !fs.existsSync(aPath)) {
        return res.status(400).json({ error: 'Files not fully uploaded' });
    }

    const id = Date.now().toString();
    const outName = `snaptrack_master_${id}.mp4`;
    const outPath = path.join(PUBLIC, outName);

    jobs[id] = { progress: 0, eta: 0, status: 'analyzing' };

    const ffprobe = spawn('/usr/bin/ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', vPath
    ]);

    let totalDuration = 0;
    ffprobe.stdout.on('data', (d) => totalDuration = parseFloat(d.toString()));
    
    ffprobe.on('close', () => {
        const sTime = parseFloat(start) || 0;
        const eTime = (parseFloat(end) > 0) ? parseFloat(end) : (totalDuration || 30);
        const clipDuration = eTime - sTime;

        const font = '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc';
        const filter = `[0:v]scale=-2:720:flags=fast_bilinear,drawtext=fontfile='${font}':text='${wm}':x=(w*${x/100}-tw/2):y=(h*${y/100}-th/2):fontsize=${fontsize}:fontcolor=${color}:shadowcolor=black@0.5:shadowx=2:shadowy=2[v];[1:a]volume=2.0,aresample=44100[a]`;

        let args = ['-nostdin', '-y', '-threads', '8'];
        if (sTime > 0) args.push('-ss', sTime.toString());
        args.push('-i', vPath, '-i', aPath);
        if (parseFloat(end) > 0) args.push('-to', clipDuration.toString());

        args.push(
            '-filter_complex', filter, '-map', '[v]', '-map', '[a]',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
            '-crf', '28', '-movflags', '+faststart', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '96k', '-shortest', outPath
        );

        const ffmpeg = spawn('/usr/bin/ffmpeg', args);
        const startTs = Date.now();
        jobs[id].status = 'rendering';

        ffmpeg.stderr.on('data', (d) => {
            const out = d.toString();
            const m = out.match(/time=(\d{2}:\d{2}:\d{2}.\d{2})/);
            if (m) {
                const cur = toSec(m[1]);
                const prog = Math.min(cur / clipDuration, 0.99);
                const elap = (Date.now() - startTs) / 1000;
                jobs[id] = { progress: Math.round(prog * 100), eta: prog > 0.05 ? Math.round((elap / prog) - elap) : 0, status: 'rendering' };
            }
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) jobs[id] = { progress: 100, eta: 0, status: 'completed', url: `/stream/${outName}` };
            else jobs[id].status = 'error';
            [vPath, aPath].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
        });
    });

    res.json({ jobId: id });
});

app.get('/progress/:id', (req, res) => res.json(jobs[req.params.id] || { status: 'not_found' }));

app.listen(port, '0.0.0.0', () => console.log(`SnapTrack Sovereign v27.0 Online | Chunk Support Active`));