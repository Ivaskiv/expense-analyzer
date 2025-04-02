import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';
import express from 'express';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { spawn } from 'child_process';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { fileURLToPath } from 'url';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';

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
 * Налаштування Google Sheets
 * @returns {Promise<GoogleSpreadsheet>} - Об'єкт документа Google Sheets
 */
const setupGoogleSheets = async () => {
  try {
    // Створення JWT клієнта для аутентифікації
    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    // Створення нового екземпляра документа
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo(); // Завантаження властивостей документа
    console.log('📊 Google Sheets підключено:', doc.title);
    return doc;
  } catch (err) {
    console.error('❌ Помилка налаштування Google Sheets:', err);
    throw err;
  }
};

/**
 * Додавання витрати до Google Sheets
 * @param {string} date - Дата витрати
 * @param {number} amount - Сума витрати
 * @param {string} category - Категорія витрати
 * @param {string} note - Примітка до витрати
 * @param {boolean} confirmed - Чи підтверджена витрата
 * @returns {Promise<boolean>} - Результат додавання
 */
const addExpenseToSheet = async (date, amount, category, note, confirmed = false) => {
  try {
    const doc = await setupGoogleSheets();
    const sheet = doc.sheetsByIndex[0]; // Отримання першого листа
    
    // Додавання нового рядка з даними про витрату
    await sheet.addRow({
      'Дата': date,
      'Сума': amount,
      'Категорія': category,
      'Запис': note,
      'Підтверджено': confirmed ? 'Так' : 'Ні'
    });
    
    return true;
  } catch (err) {
    console.error('❌ Помилка додавання витрати до таблиці:', err);
    return false;
  }
};

/**
 * Надсилання повідомлення з підтвердженням витрати
 * @param {TelegrafContext} ctx - Контекст Telegraf
 * @param {number} amount - Сума витрати
 * @param {string} category - Категорія витрати
 * @param {string} note - Примітка до витрати
 */
const sendExpenseConfirmation = async (ctx, amount, category, note) => {
  const currentDate = new Date().toISOString();
  
  // Кодування нотатки в base64 для передачі в callback даних
  const encodedNote = Buffer.from(note).toString('base64');
  
  await ctx.reply(
    `📝 *Підтвердіть витрату:*\n\n` +
    `💰 *Сума:* ${amount} грн\n` +
    `🏷️ *Категорія:* ${category}\n` +
    `📌 *Запис:* ${note}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Підтвердити', 
            `confirm_${currentDate}_${amount}_${category}_${encodedNote}`
          ),
          Markup.button.callback('❌ Скасувати', 'cancel')
        ],
        [
          Markup.button.callback('🔄 Змінити категорію', `change_category_${amount}_${encodedNote}`)
        ]
      ])
    }
  );
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
      // Використовуємо систему підтвердження
      await sendExpenseConfirmation(
        ctx, 
        analysisResult.amount, 
        analysisResult.category, 
        transcribedText
      );
    }
    
    // Видалення тимчасових файлів
    cleanupFiles([filePath]);
  } catch (err) {
    console.error('Помилка при обробці голосового повідомлення:', err);
    await ctx.reply('❌ Виникла помилка при обробці голосового повідомлення');
  }
});

/**
 * Обробник для текстових повідомлень
 */
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return; // Пропускаємо команди
  
  try {
    await ctx.reply('💰 Аналізую витрати...');
    const analysisResult = await analyzeExpense(ctx.message.text);
    
    if (analysisResult.error) {
      await ctx.reply(`❌ ${analysisResult.error}`);
    } else {
      // Створюємо клавіатуру підтвердження
      await sendExpenseConfirmation(
        ctx, 
        analysisResult.amount, 
        analysisResult.category, 
        ctx.message.text
      );
    }
  } catch (err) {
    console.error('Помилка при обробці текстового повідомлення:', err);
    await ctx.reply('❌ Виникла помилка при обробці повідомлення');
  }
});

/**
 * Обробник для кнопки підтвердження
 */
bot.action(/confirm_(.+)_(.+)_(.+)_(.+)/, async (ctx) => {
  try {
    const date = ctx.match[1];
    const amount = parseFloat(ctx.match[2]);
    const category = ctx.match[3];
    const note = Buffer.from(ctx.match[4], 'base64').toString();
    
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    await ctx.reply('⏳ Зберігаю дані...');
    
    const formattedDate = date.replace(/T/, 'T').replace(/\..+/, '');
    const success = await addExpenseToSheet(formattedDate, amount, category, note, true);
    
    if (success) {
      await ctx.reply('✅ Витрату успішно збережено в Google таблиці!');
    } else {
      await ctx.reply('❌ Не вдалося зберегти витрату. Спробуйте знову пізніше.');
    }
  } catch (err) {
    console.error('Помилка при підтвердженні витрати:', err);
    await ctx.reply('❌ Помилка при збереженні витрати');
  }
});

/**
 * Обробник для кнопки скасування
 */
bot.action('cancel', async (ctx) => {
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply('❌ Витрату скасовано');
});

/**
 * Обробник для кнопки зміни категорії
 */
bot.action(/change_category_(.+)_(.+)/, async (ctx) => {
  try {
    const amount = parseFloat(ctx.match[1]);
    const note = Buffer.from(ctx.match[2], 'base64').toString();
    
    const categories = ['продукти', 'кафе', 'покупки', 'комунальні послуги', 'спорт', 'канцтовари', 'інші'];
    
    const buttons = [];
    for (let i = 0; i < categories.length; i += 2) {
      const row = [];
      row.push(Markup.button.callback(categories[i], `set_category_${amount}_${categories[i]}_${ctx.match[2]}`));
      
      if (i + 1 < categories.length) {
        row.push(Markup.button.callback(categories[i+1], `set_category_${amount}_${categories[i+1]}_${ctx.match[2]}`));
      }
      
      buttons.push(row);
    }
    
    await ctx.editMessageReplyMarkup(Markup.inlineKeyboard(buttons));
  } catch (err) {
    console.error('Помилка при зміні категорії:', err);
    await ctx.reply('❌ Помилка при зміні категорії');
  }
});

/**
 * Обробник для вибору категорії
 */
bot.action(/set_category_(.+)_(.+)_(.+)/, async (ctx) => {
  try {
    const amount = parseFloat(ctx.match[1]);
    const category = ctx.match[2];
    const note = Buffer.from(ctx.match[3], 'base64').toString();
    
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    
    // Надсилаємо нове підтвердження з оновленою категорією
    await sendExpenseConfirmation(ctx, amount, category, note);
  } catch (err) {
    console.error('Помилка при виборі категорії:', err);
    await ctx.reply('❌ Помилка при виборі категорії');
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
    'Надішліть мені голосове повідомлення або текст з описом ваших витрат, і я визначу суму та категорію.\n\n' +
    'Наприклад: "Купив продукти на 450 гривень" або "Заплатив за комунальні 1200"'
  );
});

// Обробник для команди /help
bot.command('help', async (ctx) => {
  await ctx.reply(
    '🤖 *Як користуватися ботом:*\n\n' +
    '1. Запишіть голосове повідомлення або надішліть текст з описом витрат\n' +
    '2. Я автоматично розпізнаю текст та аналізую витрати\n' +
    '3. Ви отримаєте повідомлення з підтвердженням\n' +
    '4. Підтвердіть витрату або змініть категорію\n' +
    '5. Після підтвердження дані будуть додані до Google таблиці\n\n' +
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

// Ендпоінт для перевірки стану сервера
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'expense-tracker-bot',
    version: '1.0.0'
  });
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