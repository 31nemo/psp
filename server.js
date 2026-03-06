const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 3000;

// 업로드/작업 임시 디렉토리
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');

// psxpackager.exe 경로 (server.js와 같은 폴더)
const PSXPACKAGER = path.join(__dirname, 'psxpackager.exe');

[UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// multer 설정: 세션 ID별 폴더에 저장
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const sessionId = req.headers['x-session-id'] || uuidv4();
        const sessionDir = path.join(UPLOAD_DIR, sessionId);
        fs.mkdirSync(sessionDir, { recursive: true });
        req.sessionId = sessionId;
        cb(null, sessionDir);
    },
    filename: (req, file, cb) => {
        // 원래 파일명 그대로 저장 (인코딩 보존)
        cb(null, Buffer.from(file.originalname, 'latin1').toString('utf8'));
    }
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.cue', '.bin'].includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('CUE 또는 BIN 파일만 허용됩니다.'));
        }
    },
    limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 전환 상태 추적
const jobs = {};

// 파일 업로드 및 변환 시작
app.post('/api/convert', (req, res) => {
    const sessionId = uuidv4();

    const uploadMiddleware = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => {
                const sessionDir = path.join(UPLOAD_DIR, sessionId);
                fs.mkdirSync(sessionDir, { recursive: true });
                cb(null, sessionDir);
            },
            filename: (req, file, cb) => {
                const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
                cb(null, name);
            }
        }),
        fileFilter: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            if (['.cue', '.bin'].includes(ext)) cb(null, true);
            else cb(new Error('CUE 또는 BIN 파일만 허용됩니다.'));
        },
        limits: { fileSize: 2 * 1024 * 1024 * 1024 }
    }).fields([
        { name: 'cue', maxCount: 1 },
        { name: 'bin', maxCount: 20 }
    ]);

    uploadMiddleware(req, res, (err) => {
        if (err) {
            return res.status(400).json({ error: err.message });
        }

        const sessionDir = path.join(UPLOAD_DIR, sessionId);
        const outputDir = path.join(OUTPUT_DIR, sessionId);
        fs.mkdirSync(outputDir, { recursive: true });

        // CUE 파일 찾기
        const files = fs.readdirSync(sessionDir);
        const cueFile = files.find(f => f.toLowerCase().endsWith('.cue'));

        if (!cueFile) {
            cleanup(sessionDir);
            return res.status(400).json({ error: 'CUE 파일이 없습니다.' });
        }

        const cueFilePath = path.join(sessionDir, cueFile);
        const gameName = path.basename(cueFile, '.cue');

        // 작업 등록
        jobs[sessionId] = {
            status: 'converting',
            progress: 0,
            logs: [],
            gameName,
            outputDir,
            sessionDir,
            createdAt: Date.now()
        };

        res.json({ sessionId, gameName });

        // psxpackager 실행
        runConversion(sessionId, cueFilePath, outputDir);
    });
});

function runConversion(sessionId, cueFilePath, outputDir) {
    const job = jobs[sessionId];
    if (!job) return;

    // psxpackager가 없으면 시뮬레이션 모드
    if (!fs.existsSync(PSXPACKAGER)) {
        job.logs.push('[경고] psxpackager.exe를 찾을 수 없습니다. 데모 모드로 실행합니다.');
        job.logs.push(`입력: ${cueFilePath}`);
        job.logs.push('변환 중... (실제 실행은 psxpackager.exe가 필요합니다)');
        setTimeout(() => {
            job.status = 'error';
            job.error = 'psxpackager.exe 파일이 서버에 없습니다. server.js와 같은 폴더에 배치해주세요.';
        }, 2000);
        return;
    }

    const args = ['-i', cueFilePath, '-o', outputDir, '-x', '-v', '3'];
    const proc = spawn(PSXPACKAGER, args);

    proc.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        lines.forEach(line => {
            job.logs.push(line);
            // 진행률 파싱
            const match = line.match(/(\d+)%/);
            if (match) job.progress = parseInt(match[1]);
        });
    });

    proc.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        lines.forEach(line => job.logs.push(`[오류] ${line}`));
    });

    proc.on('close', (code) => {
        if (code === 0) {
            // 생성된 PBP 파일 찾기
            const outFiles = fs.readdirSync(outputDir);
            const pbpFile = outFiles.find(f => f.toLowerCase().endsWith('.pbp'));

            if (pbpFile) {
                job.status = 'done';
                job.progress = 100;
                job.pbpFile = pbpFile;
                job.logs.push(`✅ 변환 완료: ${pbpFile}`);
            } else {
                job.status = 'error';
                job.error = 'PBP 파일이 생성되지 않았습니다.';
                job.logs.push('❌ PBP 파일을 찾을 수 없습니다.');
            }
        } else {
            job.status = 'error';
            job.error = `psxpackager가 오류 코드 ${code}로 종료되었습니다.`;
            job.logs.push(`❌ 변환 실패 (코드: ${code})`);
        }
        // 업로드 폴더 정리
        setTimeout(() => cleanup(job.sessionDir), 5000);
    });

    proc.on('error', (err) => {
        job.status = 'error';
        job.error = `실행 오류: ${err.message}`;
        job.logs.push(`❌ ${err.message}`);
    });
}

// 작업 상태 조회
app.get('/api/status/:sessionId', (req, res) => {
    const job = jobs[req.params.sessionId];
    if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });

    res.json({
        status: job.status,
        progress: job.progress,
        logs: job.logs,
        gameName: job.gameName,
        pbpFile: job.pbpFile,
        error: job.error
    });
});

// PBP 파일 다운로드
app.get('/api/download/:sessionId', (req, res) => {
    const job = jobs[req.params.sessionId];
    if (!job || job.status !== 'done') {
        return res.status(404).json({ error: '다운로드 가능한 파일이 없습니다.' });
    }

    const filePath = path.join(job.outputDir, job.pbpFile);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '파일이 존재하지 않습니다.' });
    }

    res.download(filePath, job.pbpFile, (err) => {
        if (!err) {
            // 다운로드 완료 후 정리 (5분 뒤)
            setTimeout(() => {
                cleanup(job.outputDir);
                delete jobs[req.params.sessionId];
            }, 5 * 60 * 1000);
        }
    });
});

function cleanup(dir) {
    try {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    } catch (e) {
        console.error('정리 실패:', e.message);
    }
}

// 오래된 작업 자동 정리 (1시간마다)
setInterval(() => {
    const now = Date.now();
    Object.entries(jobs).forEach(([id, job]) => {
        if (now - job.createdAt > 60 * 60 * 1000) {
            cleanup(job.sessionDir);
            cleanup(job.outputDir);
            delete jobs[id];
        }
    });
}, 60 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`🎮 PSX PBP Converter 서버 실행 중: http://localhost:${PORT}`);
    console.log(`psxpackager.exe 경로: ${PSXPACKAGER}`);
    console.log(`psxpackager.exe 존재: ${fs.existsSync(PSXPACKAGER)}`);
});
