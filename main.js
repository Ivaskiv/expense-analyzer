import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { Deepgram } from '@deepgram/sdk';
import dotenv from 'dotenv';
import winston from 'winston';
import { fileURLToPath } from 'url';

dotenv.config();

// ES modules equivalent for dirname
const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

winston.configure({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'app.log' })
  ]
});

const app = express();
const port = process.env.PORT || 3000;

const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
const deepgram = new Deepgram(deepgramApiKey);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedMimes = ['audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/ogg'];
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Непідтримуваний тип файлу. Підтримуються лише WAV, MP3 та OGG.'), false);
  }
};

const upload = multer({ 
  storage: storage, 
  fileFilter: fileFilter,
  limits: { fileSize: 25 * 1024 * 1024 } 
});

app.get('/health', (req, res) => {
  if (!deepgramApiKey) {
    return res.status(503).json({
      status: 'error',
      message: 'Deepgram API ключ не налаштовано'
    });
  }
  
  res.json({
    status: 'ok',
    service: 'expense-analyzer',
    version: '1.0.0'
  });
});

app.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Аудіофайл не надіслано' });
  }

  try {
    winston.info(`Початок транскрибації файлу ${req.file.filename}`);
    
    const filePath = req.file.path;
    const mimetype = req.file.mimetype;
    const audioSource = { buffer: fs.readFileSync(filePath), mimetype };
    
    const transcriptionOptions = {
      language: 'uk',
      model: 'general',
      punctuate: true,
      diarize: false
    };
    
    const result = await deepgram.transcription.preRecorded(audioSource, transcriptionOptions);
    
    const transcription = result.results.channels[0].alternatives[0].transcript;
    
    winston.info(`Транскрибацію файлу ${req.file.filename} завершено успішно`);
    
    const expenses = analyzeExpenses(transcription);
    
    fs.unlinkSync(filePath);
    
    res.json({
      transcription,
      expenses
    });
  } catch (error) {
    winston.error(`Помилка при транскрибації: ${error.message}`);
    
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ 
      error: 'Помилка при обробці аудіо',
      details: error.message 
    });
  }
});

function analyzeExpenses(text) {
  const expenses = [];
  
  const amountRegex = /(\d+(?:[.,]\d+)?)\s*(грн|гривень|грн\.|₴|uah)/gi;
  let match;
  
  while ((match = amountRegex.exec(text)) !== null) {
    const amount = parseFloat(match[1].replace(',', '.'));
    const currency = match[2].toLowerCase();
    
    let category = 'Інше';
    if (text.includes('їжа') || text.includes('ресторан') || text.includes('кафе')) {
      category = 'Їжа';
    } else if (text.includes('таксі') || text.includes('бензин') || text.includes('транспорт')) {
      category = 'Транспорт';
    } else if (text.includes('магазин') || text.includes('супермаркет')) {
      category = 'Покупки';
    }
    
    expenses.push({
      amount,
      currency: 'UAH',
      category,
      matchedText: match[0],
      position: match.index
    });
  }
  
  return expenses;
}

app.listen(port, () => {
  winston.info(`Сервер запущено на порту ${port}`);
});

export default app;