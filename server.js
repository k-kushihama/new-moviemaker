/**
 * SnapTrack Sovereign Engine v43.0 (Smart Preview Edition)
 * Optimized for Proxmox LXC | 16:9 Forced | Smart Mode Logic
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
const TMP_TEXT = path.join(DATA, 'tmp_text');

[DATA, UPLOADS, PUBLIC, TMP_TEXT].forEach(dir => {
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

app.post('/upload-chunk', upload.single('chunk'), (req, res) => {
    const { filename, chunkIndex } = req.body;
    const targetPath = path.join(UPLOADS, filename);
    if (parseInt(chunkIndex) === 0 && fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    fs.appendFileSync(targetPath, fs.readFileSync(req.file.path));
    fs.unlinkSync(req.file.path);
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

app.post('/process', (req, res) => {
    const { mode, videoName, audioName, imageName, wm, x, y, fontsize, color, start, end, fadeIn, fadeOut, title, tx, ty, tfs, jx, jy } = req.body;
    const vPath = mode === 'video' ? path.join(UPLOADS, videoName) : null;
    const iPath = mode === 'music' ? path.join(UPLOADS, imageName) : null;
    const aPath = path.join(UPLOADS, audioName);
    const id = Date.now().toString();
    const outName = `master_${id}.mp4`;
    const outPath = path.join(PUBLIC, outName);

    const wmFile = path.join(TMP_TEXT, `wm_${id}.txt`);
    const titleFile = path.join(TMP_TEXT, `title_${id}.txt`);
    fs.writeFileSync(wmFile, (wm || " ") + " ");
    if (title && mode === 'music') fs.writeFileSync(titleFile, title);

    jobs[id] = { progress: 0, eta: 0, status: 'initializing' };

    let totalDur = 30;
    try {
        totalDur = parseFloat(execSync(`/usr/bin/ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${aPath}"`).toString()) || 30;
    } catch (e) {}

    const sTime = parseFloat(start) || 0;
    const eTime = (parseFloat(end) > 0) ? parseFloat(end) : totalDur;
    const finalDur = Math.max(eTime - sTime, 1);
    const font = '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc';

    let vF = "";
    if (mode === 'music') {
        vF = `[0:v]scale=160:90,boxblur=5:1,scale=1280:720,eq=brightness=0.2[bg];` +
             `[0:v]scale=560:560:force_original_aspect_ratio=decrease[fg];` +
             `[bg][fg]overlay=(W*${jx}/100-w/2):(H*${jy}/100-h/2),setdar=16/9[v_base];`;
    } else {
        vF = `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setdar=16/9[v_base];`;
    }

    vF += `[v_base]drawtext=fontfile='${font}':textfile='${wmFile}':x=(w*${x/100}-tw/2):y=(h*${y/100}-th/2):fontsize=${fontsize}:fontcolor=${color}:shadowcolor=black@0.5:shadowx=2:shadowy=2`;
    
    // Videoモードではタイトルを描画しない
    if (title && mode === 'music') {
        vF += `,drawtext=fontfile='${font}':textfile='${titleFile}':x=(w*${tx/100}-tw/2):y=(h*${ty/100}-th/2):fontsize=${tfs}:fontcolor=white:shadowcolor=black@0.5:shadowx=2:shadowy=2:line_spacing=10`;
    }

    if (parseFloat(fadeIn) > 0) vF += `,fade=t=in:st=0:d=${fadeIn}`;
    if (parseFloat(fadeOut) > 0) vF += `,fade=t=out:st=${finalDur - fadeOut}:d=${fadeOut}`;
    vF += `[v_out]`;

    let aF = `[1:a]volume=2.0,aresample=44100`;
    if (parseFloat(fadeIn) > 0) aF += `,afade=t=in:st=0:d=${fadeIn}`;
    if (parseFloat(fadeOut) > 0) aF += `,afade=t=out:st=${finalDur - fadeOut}:d=${fadeOut}`;
    aF += `[a_out]`;

    let args = ['-nostdin', '-y', '-threads', '8', '-progress', 'pipe:1'];
    if (mode === 'music') args.push('-loop', '1', '-t', finalDur.toString(), '-i', iPath);
    else { if (sTime > 0) args.push('-ss', sTime.toString()); args.push('-i', vPath); }
    args.push('-i', aPath, '-t', finalDur.toString(), '-filter_complex', `${vF};${aF}`, '-map', '[v_out]', '-map', '[a_out]', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '26', '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', outPath);

    const ffmpeg = spawn('/usr/bin/ffmpeg', args);
    const startTs = Date.now();
    jobs[id].status = 'rendering';

    ffmpeg.stdout.on('data', (d) => {
        const lines = d.toString().split('\n');
        lines.forEach(line => {
            if (line.startsWith('out_time_us=')) {
                const prog = Math.min((parseInt(line.split('=')[1]) / 1000000) / finalDur, 0.99);
                jobs[id] = { progress: Math.round(prog * 100), eta: prog > 0.05 ? Math.round(((Date.now() - startTs) / 1000 / prog) - ((Date.now() - startTs) / 1000)) : 0, status: 'rendering' };
            }
        });
    });

    ffmpeg.on('close', code => {
        if (code === 0) jobs[id] = { progress: 100, eta: 0, status: 'completed', url: `/stream/${outName}` };
        else jobs[id].status = 'error';
        setTimeout(() => { [vPath, iPath, aPath, wmFile, titleFile].forEach(p => p && fs.existsSync(p) && fs.unlinkSync(p)); }, 15000);
    });
    res.json({ jobId: id });
});

app.get('/progress/:id', (req, res) => res.json(jobs[req.params.id] || { status: 'not_found', progress: 0 }));
app.listen(port, '0.0.0.0', () => console.log(`SnapTrack Sovereign v43.0 Smart Preview Online`));