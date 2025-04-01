import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import { GoogleGenerativeAI } from '@google/generative-ai';
import express from 'express';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { spawn } from 'child_process';
import io from 'io';

dotenv.config();

const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');
const COQUI_MODEL_PATH = process.env.COQUI_MODEL_PATH || path.join(__dirname, 'models/ukrainian');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const app = express();
app.use(express.json({
  verify: (req, res, buf, encoding) => {
    req.rawBody = buf.toString(encoding || 'utf8');
  },
  strict: false
}));

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const fastApiApp = express();

const analyzeExpense = async (text) => {
  const EXPENSE_PROMPT = `Проаналізуй ці витрати: "${text}" і визнач суму та категорію.
Сума - це число без валюти.
Категорії: продукти, кафе, покупки, комунальні послуги, спорт, канцтовари, інші.
Якщо текст містить слова про зошити, ручки, олівці, папір - це категорія "канцтовари".
Поверни лише два значення через кому: суму (тільки число) та категорію. Наприклад: "500, канцтовари"`;

  try {
    const result = await model.generateContent(EXPENSE_PROMPT);
    const response = result.response.text().trim();
    const match = response.match(/(\d+(?:\.\d+)?)\s*,\s*([а-яіїєґА-ЯІЇЄҐ\s]+)/);
    return match ? { amount: parseFloat(match[1]), category: match[2].trim() } : { error: 'Не вдалося визначити категорію витрат' };
  } catch (err) {
    console.error('Помилка аналізу витрат:', err);
    return { error: 'Помилка при аналізі витрат' };
  }
};

bot.on(['voice', 'audio'], async (ctx) => {
  try {
    const fileId = ctx.message.voice ? ctx.message.voice.file_id : ctx.message.audio.file_id;
    const filePath = await downloadAudioFile(fileId);
    const transcribedText = await transcribeAudio(filePath);
    await ctx.reply(`📝 Розпізнаний текст: "${transcribedText}"`);
    const analysisResult = await analyzeExpense(transcribedText);
    await ctx.reply(`💰 Сума: ${analysisResult.amount} \n🏷️ Категорія: ${analysisResult.category}`);
    cleanupFiles([filePath]);
  } catch (err) {
    console.error('Помилка при обробці голосового повідомлення:', err);
    await ctx.reply('❌ Виникла помилка при обробці голосового повідомлення');
  }
});

const downloadAudioFile = async (fileId) => {
  try {
    const fileInfo = await bot.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    const fileName = `${Date.now()}.ogg`;
    const filePath = path.join(TEMP_DIR, fileName);
    const response = await axios.get(fileUrl, { responseType: 'stream' });
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(filePath));
      writer.on('error', reject);
    });
  } catch (err) {
    console.error('Помилка завантаження аудіо:', err);
    throw err;
  }
};

const transcribeAudio = async (filePath) => {
  try {
    const wavFilePath = `${filePath}.wav`;
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', ['-i', filePath, '-ar', '16000', '-ac', '1', '-f', 'wav', wavFilePath]);
      ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg process exited with code ${code}`)));
    });
    return new Promise((resolve, reject) => {
      const coqui = spawn('stt', ['--model', COQUI_MODEL_PATH, '--audio', wavFilePath]);
      let transcribedText = '';
      coqui.stdout.on('data', data => transcribedText += data.toString());
      coqui.on('close', code => code === 0 ? resolve(transcribedText.trim()) : reject(new Error('Coqui STT failed')));
    });
  } catch (err) {
    console.error('Помилка при транскрибації аудіо:', err);
    throw err;
  }
};

const cleanupFiles = (filePaths) => {
  filePaths.forEach(filePath => {
    const basePath = filePath.substring(0, filePath.lastIndexOf('.'));
    ['.ogg', '.wav', '.txt'].forEach(ext => {
      const fileToDelete = `${basePath}${ext}`;
      if (fs.existsSync(fileToDelete)) {
        fs.unlinkSync(fileToDelete);
      }
    });
  });
};

app.listen(PORT, () => {
  console.log(`Сервер працює на порту ${PORT}`);
});
