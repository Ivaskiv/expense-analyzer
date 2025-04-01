import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import express from 'express';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { spawn } from 'child_process';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { fileURLToPath } from 'url';

// ES modules equivalent for dirname
const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

// Завантаження змінних середовища
dotenv.config();

// Ініціалізація Google Generative AI
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL_NAME || 'gemini-pro' });

// Константи
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(dirname, 'temp');
const COQUI_MODEL_PATH = process.env.COQUI_MODEL_PATH || path.join(dirname, 'models/ukrainian');

// Створення тимчасової директорії, якщо вона не існує
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Ініціалізація Express
const app = express();
app.use(express.json({
  verify: (req, res, buf, encoding) => {
    req.rawBody = buf.toString(encoding || 'utf8');
  },
  strict: false
}));

// Ініціалізація Telegram бота
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

/**
 * Аналіз тексту для виділення суми та категорії витрат
 * @param {string} text - Текст для аналізу
 * @returns {Promise<Object>} - Результат аналізу (сума та категорія)
 */
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
    return match 
      ? { amount: parseFloat(match[1]), category: match[2].trim() } 
      : { error: 'Не вдалося визначити категорію витрат', rawResponse: response };
  } catch (err) {
    console.error('Помилка аналізу витрат:', err);
    return { error: 'Помилка при аналізі витрат' };
  }
};

/**
 * Обробник для голосових повідомлень та аудіо
 */
bot.on(['voice', 'audio'], async (ctx) => {
  try {
    await ctx.reply('🎙️ Обробляю ваше аудіо...');
    
    const fileId = ctx.message.voice ? ctx.message.voice.file_id : ctx.message.audio.file_id;
    const filePath = await downloadAudioFile(fileId);
    
    await ctx.reply('🔄 Розпізнаю текст...');
    const transcribedText = await transcribeAudio(filePath);
    
    await ctx.reply(`📝 Розпізнаний текст: "${transcribedText}"`);
    
    await ctx.reply('💰 Аналізую витрати...');
    const analysisResult = await analyzeExpense(transcribedText);
    
    if (analysisResult.error) {
      await ctx.reply(`❌ ${analysisResult.error}`);
    } else {
      await ctx.reply(`✅ Аналіз завершено!\n💰 Сума: ${analysisResult.amount} грн\n🏷️ Категорія: ${analysisResult.category}`);
    }
    
    // Видалення тимчасових файлів
    cleanupFiles([filePath]);
  } catch (err) {
    console.error('Помилка при обробці голосового повідомлення:', err);
    await ctx.reply('❌ Виникла помилка при обробці голосового повідомлення');
  }
});

/**
 * Завантаження аудіофайлу з Telegram
 * @param {string} fileId - ID файлу в Telegram
 * @returns {Promise<string>} - Шлях до завантаженого файлу
 */
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

/**
 * Транскрибація аудіо за допомогою Coqui STT
 * @param {string} filePath - Шлях до аудіофайлу
 * @returns {Promise<string>} - Розпізнаний текст
 */
const transcribeAudio = async (filePath) => {
  try {
    const wavFilePath = `${filePath}.wav`;
    
    // Конвертація аудіо в WAV формат за допомогою ffmpeg
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-i', filePath, 
        '-ar', '16000',  // Частота дискретизації 16kHz
        '-ac', '1',      // Моно канал
        '-f', 'wav',     // WAV формат
        wavFilePath
      ]);
      
      ffmpeg.stderr.on('data', (data) => {
        console.log(`ffmpeg stderr: ${data}`);
      });
      
      ffmpeg.on('close', code => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg process exited with code ${code}`));
        }
      });
    });
    
    // Транскрибація за допомогою Coqui STT
    return new Promise((resolve, reject) => {
      const coqui = spawn('stt', ['--model', COQUI_MODEL_PATH, '--audio', wavFilePath]);
      let transcribedText = '';
      
      coqui.stdout.on('data', data => {
        transcribedText += data.toString();
      });
      
      coqui.stderr.on('data', (data) => {
        console.log(`coqui stderr: ${data}`);
      });
      
      coqui.on('close', code => {
        if (code === 0) {
          resolve(transcribedText.trim());
        } else {
          reject(new Error(`Coqui STT failed with code ${code}`));
        }
      });
    });
  } catch (err) {
    console.error('Помилка при транскрибації аудіо:', err);
    throw err;
  }
};

/**
 * Видалення тимчасових файлів
 * @param {Array<string>} filePaths - Масив шляхів до файлів
 */
const cleanupFiles = (filePaths) => {
  filePaths.forEach(filePath => {
    const basePath = filePath.substring(0, filePath.lastIndexOf('.'));
    ['.ogg', '.wav', '.txt'].forEach(ext => {
      const fileToDelete = `${basePath}${ext}`;
      if (fs.existsSync(fileToDelete)) {
        try {
          fs.unlinkSync(fileToDelete);
          console.log(`Видалено файл: ${fileToDelete}`);
        } catch (err) {
          console.error(`Помилка видалення файлу ${fileToDelete}:`, err);
        }
      }
    });
  });
};

// Обробник для команди /start
bot.command('start', async (ctx) => {
  await ctx.reply(
    'Привіт! Я бот для аналізу витрат. 💰\n\n' +
    'Надішліть мені голосове повідомлення з описом ваших витрат, і я визначу суму та категорію.\n\n' +
    'Наприклад: "Купив продукти на 450 гривень" або "Заплатив за комунальні 1200"'
  );
});

// Обробник для команди /help
bot.command('help', async (ctx) => {
  await ctx.reply(
    '🤖 *Як користуватися ботом:*\n\n' +
    '1. Запишіть голосове повідомлення з описом витрат\n' +
    '2. Я автоматично розпізнаю текст та аналізую витрати\n' +
    '3. Ви отримаєте суму та категорію витрат\n\n' +
    '*Доступні категорії:*\n' +
    '• продукти 🛒\n' +
    '• кафе 🍽️\n' +
    '• покупки 🛍️\n' +
    '• комунальні послуги 💡\n' +
    '• спорт 🏋️\n' +
    '• канцтовари 📝\n' +
    '• інші 🔄',
    { parse_mode: 'Markdown' }
  );
});

// Запуск бота
bot.launch().then(() => {
  console.log('🤖 Telegram бот успішно запущено');
}).catch(err => {
  console.error('Помилка запуску бота:', err);
});

// Запуск Express сервера
app.listen(PORT, () => {
  console.log(`🚀 Сервер працює на порту ${PORT}`);
});

// Обробка сигналів завершення роботи
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));