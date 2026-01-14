/**
 * SnapTrack Sovereign Engine v18.0
 * Ubuntu 22.04 / Proxmox 8-Core / RAM-Disk Accelerated
 * Port: 6011
 */

const express = require('express');
const multer = require('multer');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const port = 6011;

const RAM_PATH = '/dev/shm/snaptrack';
const UPLOAD_DIR = path.join(RAM_PATH, 'uploads');
const PUBLIC_DIR = path.join(RAM_PATH, 'public');

[UPLOAD_DIR, PUBLIC_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        fs.chmodSync(dir, '777');
    }
});

const upload = multer({ dest: UPLOAD_DIR });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/stream', express.static(PUBLIC_DIR));

app.use((req, res, next) => {
    res.header('Cross-Origin-Embedder-Policy', 'require-corp');
    res.header('Cross-Origin-Opener-Policy', 'same-origin');
    next();
});

let jobs = {};

app.post('/process', upload.fields([{ name: 'video' }, { name: 'audio' }]), (req, res) => {
    const videoFile = req.files['video'][0];
    const audioFile = req.files['audio'][0];
    const wmText = req.body.wm || 'SnapTrack';
    const posX = parseFloat(req.body.x) || 50;
    const posY = parseFloat(req.body.y) || 90;
    const fontSize = parseInt(req.body.fontsize) || 32;

    const jobId = Date.now().toString();
    const outputName = `final_${jobId}.mp4`;
    const outputPath = path.join(PUBLIC_DIR, outputName);

    try {
        const durationCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoFile.path}"`;
        const totalDuration = parseFloat(execSync(durationCmd).toString());

        jobs[jobId] = { progress: 0, eta: 0, status: 'processing' };

        const targetX = `(w*${posX/100} - tw/2)`;
        const targetY = `(h*${posY/100} - th/2)`;

        const ffmpeg = spawn('ffmpeg', [
            '-nostdin', '-y', '-threads', '8',
            '-i', videoFile.path,
            '-i', audioFile.path,
            '-filter_complex', `[0:v]scale=-2:720:flags=fast_bilinear,drawtext=text='${wmText}':x=${targetX}:y=${targetY}:fontsize=${fontSize}:fontcolor=white:shadowcolor=black@0.5:shadowx=2:shadowy=2[v];[1:a]volume=2.0,aresample=44100[a]`,
            '-map', '[v]', '-map', '[a]',
            '-c:v', 'libx264', '-preset', 'superfast', '-tune', 'fastdecode',
            '-crf', '28', '-movflags', '+faststart', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '96k', '-shortest',
            outputPath
        ]);

        const startTime = Date.now();

        ffmpeg.stderr.on('data', (data) => {
            const output = data.toString();
            const timeMatch = output.match(/time=(\d{2}:\d{2}:\d{2}.\d{2})/);
            if (timeMatch) {
                const currentTime = timeToSeconds(timeMatch[1]);
                const progress = Math.min(currentTime / totalDuration, 0.99);
                const elapsed = (Date.now() - startTime) / 1000;
                const eta = progress > 0.01 ? Math.round((elapsed / progress) - elapsed) : 0;
                jobs[jobId] = { progress: Math.round(progress * 100), eta, status: 'processing' };
            }
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                jobs[jobId] = { progress: 100, eta: 0, status: 'completed', url: `/stream/${outputName}` };
            } else {
                jobs[jobId].status = 'error';
            }
            if (fs.existsSync(videoFile.path)) fs.unlinkSync(videoFile.path);
            if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
        });

        res.json({ jobId });
    } catch (e) {
        res.status(500).send('Error');
    }
});

app.get('/progress/:id', (req, res) => res.json(jobs[req.params.id] || { status: 'not_found' }));

function timeToSeconds(timeStr) {
    const [h, m, s] = timeStr.split(':').map(parseFloat);
    return h * 3600 + m * 60 + s;
}

app.listen(port, '0.0.0.0', () => console.log(`SnapTrack Sovereign Engine v18.0 Online`));