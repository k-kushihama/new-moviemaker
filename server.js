/**
 * SnapTrack Sovereign Engine v21.0 (Survival Edition)
 * Optimized for Proxmox LXC | Port: 6011
 * SnapLynk Co.,Ltd. Standard
 */

const express = require('express');
const multer = require('multer');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const port = 6011;

// 絶対パスの取得
const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(DATA_DIR, 'public');

// フォルダの強制作成と権限付与
[DATA_DIR, UPLOAD_DIR, PUBLIC_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try { fs.chmodSync(dir, '0777'); } catch(e) {}
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
});
const upload = multer({ storage: storage });

app.use(express.static(path.join(ROOT_DIR, 'public')));
app.use('/stream', express.static(PUBLIC_DIR));

app.use((req, res, next) => {
    res.header('Cross-Origin-Embedder-Policy', 'require-corp');
    res.header('Cross-Origin-Opener-Policy', 'same-origin');
    next();
});

let jobs = {};

app.post('/process', upload.fields([{ name: 'video' }, { name: 'audio' }]), (req, res) => {
    const videoFile = req.files['video']?.[0];
    const audioFile = req.files['audio']?.[0];
    if (!videoFile || !audioFile) return res.status(400).json({ error: 'Files missing' });

    const { wm, x, y, fontsize } = req.body;
    const jobId = Date.now().toString();
    const outputName = `final_${jobId}.mp4`;
    const outputPath = path.join(PUBLIC_DIR, outputName);

    // フォントパスの再確認（LXC標準）
    const fontPath = '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc';

    try {
        const durationCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoFile.path}"`;
        const totalDuration = parseFloat(execSync(durationCmd).toString());
        jobs[jobId] = { progress: 0, eta: 0, status: 'processing' };

        const targetX = `(w*${x/100} - tw/2)`;
        const targetY = `(h*${y/100} - th/2)`;

        // ハングアップを避けるための純粋CPU設定
        const ffmpeg = spawn('ffmpeg', [
            '-nostdin', '-y',
            '-threads', '8', // 8Coreをフル稼働
            '-i', videoFile.path,
            '-i', audioFile.path,
            '-filter_complex', `[0:v]scale=-2:720:flags=fast_bilinear,drawtext=fontfile='${fontPath}':text='${wm}':x=${targetX}:y=${targetY}:fontsize=${fontsize}:fontcolor=white:shadowcolor=black@0.5:shadowx=2:shadowy=2[v];[1:a]volume=2.0,aresample=44100[a]`,
            '-map', '[v]', '-map', '[a]',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
            '-crf', '28', '-movflags', '+faststart', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '96k', '-shortest',
            outputPath
        ]);

        const startTime = Date.now();

        ffmpeg.stderr.on('data', (data) => {
            const out = data.toString();
            console.log(`[FFMPEG DEBUG] ${out}`); // 全てのログをコンソールへ
            const timeMatch = out.match(/time=(\d{2}:\d{2}:\d{2}.\d{2})/);
            if (timeMatch) {
                const currentTime = timeToSeconds(timeMatch[1]);
                const progress = Math.min(currentTime / totalDuration, 0.99);
                const elapsed = (Date.now() - startTime) / 1000;
                const eta = progress > 0.01 ? Math.round((elapsed / progress) - elapsed) : 0;
                jobs[jobId] = { progress: Math.round(progress * 100), eta, status: 'processing' };
            }
        });

        ffmpeg.on('close', (code) => {
            console.log(`[JOB ${jobId}] Closed with code ${code}`);
            if (code === 0) {
                jobs[jobId] = { progress: 100, eta: 0, status: 'completed', url: `/stream/${outputName}` };
            } else {
                jobs[jobId].status = 'error';
            }
            // 不要なファイルを即座に削除
            [videoFile.path, audioFile.path].forEach(p => { if(fs.existsSync(p)) fs.unlinkSync(p); });
        });

        res.json({ jobId });
    } catch (e) {
        console.error("Critical Error:", e);
        res.status(500).json({ error: 'Init Failed' });
    }
});

app.get('/progress/:id', (req, res) => res.json(jobs[req.params.id] || { status: 'not_found' }));

function timeToSeconds(timeStr) {
    const [h, m, s] = timeStr.split(':').map(parseFloat);
    return h * 3600 + m * 60 + s;
}

app.listen(port, '0.0.0.0', () => console.log(`SnapTrack Sovereign v21.0 Online at ${port}`));