import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';
import express from 'express';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import OpenAI from 'openai';
import { exec } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';

// Встановлення шляхів
const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

// Конфігурація змінних середовища
dotenv.config();

// Константи
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(dirname, 'temp');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEFAULT_CATEGORIES = ['продукти', 'кафе', 'покупки', 'комунальні послуги', 'спорт', 'канцтовари', 'транспорт', 'розваги', 'здоров\'я', 'інші'];

// Перевірка, чи існує тимчасова директорія
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Ініціалізація OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Ініціалізація Express App
const app = express();
app.use(express.json());

// Перевірка наявності необхідних змінних оточення
if (!TELEGRAM_BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не встановлено!');
  process.exit(1);
}

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY не встановлено!');
  process.exit(1);
}

// Ініціалізація Telegram бота
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const noteStorage = {};

/**
 * Аналізує текст для виявлення витрат
 * @param {string} text - Текст для аналізу
 * @returns {Object} - Результат аналізу з сумою та категорією
 */
const analyzeExpense = (text) => {
  try {
    if (!text || typeof text !== 'string') {
      return { error: 'Текст для аналізу відсутній або некоректний' };
    }
    
    // Пошук суми з валютою
    const amountRegex = /(\d+(?:[.,]\d+)?)\s*(грн|гривень|грн\.|₴|uah|)/gi;
    let amountMatch = amountRegex.exec(text);
    
    let amount = 0;
    if (amountMatch) {
      // Замінюємо кому на крапку для коректного парсингу
      amount = parseFloat(amountMatch[1].replace(',', '.'));
    } else {
      // Спробуємо знайти просто числа
      const numberMatch = /(\d+(?:[.,]\d+)?)/.exec(text);
      if (numberMatch) {
        amount = parseFloat(numberMatch[1].replace(',', '.'));
      }
    }
    
    // Визначення категорії
    let category = 'інші';
    const lowerText = text.toLowerCase();
    
    const categoryPatterns = {
      'продукти': /прод[ау]кт|їж[аіу]|хліб|молоко|овоч|фрукт|магазин|супермаркет|маркет/i,
      'кафе': /каф[еє]|ресторан|їдальн|обід|вечер[яю]|снідан[ок]|піц[ау]|суші|фастфуд/i,
      'комунальні послуги': /комунал|світло|газ|вод[аи]|опален|електро|інтернет|телефон/i,
      'спорт': /спорт|трену|фітнес|абонемент|зал|басейн|йога/i,
      'канцтовари': /зошит|ручк|олівц|папір|канц|книг|канцеляр/i,
      'покупки': /одяг|взутт|сороч|магазин|купив|купил|придба|шопінг|шоппінг/i,
      'транспорт': /автобус|метро|таксі|поїзд|квиток|проїзд|бензин|паливо/i,
      'розваги': /кіно|театр|концерт|розваг|вистав|парк|атракціон/i,
      'здоров\'я': /лік|аптек|медиц|лікар|стоматолог|терапевт|здоров/i
    };
    
    for (const [cat, pattern] of Object.entries(categoryPatterns)) {
      if (pattern.test(lowerText)) {
        category = cat;
        break;
      }
    }
    
    return { amount, category };
  } catch (err) {
    console.error('❌ Помилка аналізу витрат:', err);
    return { error: 'Помилка при аналізі витрат' };
  }
};

/**
 * Налаштування Google Sheets
 * @returns {Promise<Object>} - Google Sheets документ
 */
const setupGoogleSheets = async () => {
  try {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !process.env.GOOGLE_SHEET_ID) {
      throw new Error('Відсутні необхідні змінні оточення для Google Sheets');
    }
    
    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo(); 
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
 * @param {string} note - Опис витрати
 * @returns {Promise<boolean>} - Результат операції
 */
const addExpenseToSheet = async (date, amount, category, note) => {
  try {
    const doc = await setupGoogleSheets();
    const sheet = doc.sheetsByIndex[0]; 
    
    // Форматування дати
    const formattedDateTime = new Date(date).toLocaleString('uk-UA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    await sheet.addRow({
      'Дата': formattedDateTime,
      'Сума': amount,
      'Категорія': category,
      'Запис': note
    });
    
    return true;
  } catch (err) {
    console.error('❌ Помилка додавання витрати до таблиці:', err);
    return false;
  }
};

/**
 * Відправка підтвердження витрати
 * @param {Object} ctx - Контекст Telegraf
 * @param {number} amount - Сума витрати
 * @param {string} category - Категорія витрати
 * @param {string} note - Опис витрати
 */
const sendExpenseConfirmation = async (ctx, amount, category, note) => {
  const noteId = Date.now().toString();
  noteStorage[noteId] = note;
  
  await ctx.reply(
    `📊 *Результат аналізу:*\n` +
    `📝 Текст: ${note}\n` +
    `💰 Сума: ${amount} грн\n` +
    `🗂️ Категорія: ${category}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Підтвердити', 
            `confirm_${amount}_${category}_${noteId}`
          ),
          Markup.button.callback('❌ Скасувати', 'cancel')
        ],
        [
          Markup.button.callback('🔄 Змінити категорію', `change_category_${amount}_${noteId}`),
          Markup.button.callback('✏️ Змінити суму', `change_amount_${amount}_${category}_${noteId}`)
        ]
      ])
    }
  );
};

/**
 * Транскрибування аудіо через Whisper API
 * @param {string} filePath - Шлях до аудіофайлу
 * @returns {Promise<string>} - Розпізнаний текст
 */
const transcribeAudio = async (filePath) => {
  try {
    console.log(`🎙️ Конвертую аудіо у WAV: ${filePath}`);
    
    // Створюємо шлях до нового файлу
    const wavPath = filePath.replace(path.extname(filePath), '.wav');

    // Конвертуємо у WAV (16 kHz, 1 канал, PCM S16LE)
    await new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .output(wavPath)
        .audioFrequency(16000)
        .audioChannels(1)
        .audioCodec('pcm_s16le')
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    console.log(`📝 Відправляю аудіо на Whisper API`);
    const fileStream = fs.createReadStream(wavPath);
    
    const response = await openai.audio.transcriptions.create({
      file: fileStream,
      model: "whisper-1",
      language: "uk"
    });

    console.log(`✅ Розпізнаний текст: ${response.text}`);
    
    // Очищення тимчасового файлу WAV
    cleanupFiles([wavPath]);
    
    return response.text || "Не вдалося розпізнати аудіо.";
  } catch (err) {
    console.error('❌ Помилка при транскрибації аудіо:', err);
    return "Не вдалося розпізнати аудіо. Спробуйте ще раз.";
  }
};

/**
 * Завантаження аудіофайлу
 * @param {string} fileId - ID файлу Telegram
 * @returns {Promise<string>} - Шлях до завантаженого файлу
 */
const downloadAudioFile = async (fileId) => {
  try {
    const fileInfo = await bot.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
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
    console.error('❌ Помилка завантаження аудіо:', err);
    throw err;
  }
};

/**
 * Очищення тимчасових файлів
 * @param {Array<string>} filePaths - Масив шляхів до файлів
 */
const cleanupFiles = (filePaths) => {
  filePaths.forEach(filePath => {
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Видалено файл: ${filePath}`);
      } catch (err) {
        console.error(`❌ Помилка видалення файлу ${filePath}:`, err);
      }
    }
  });
};

// Обробка голосових повідомлень
bot.on(['voice', 'audio'], async (ctx) => {
  try {
    await ctx.reply('🎙️ Обробляю ваше аудіо...');
    
    const fileId = ctx.message.voice ? ctx.message.voice.file_id : ctx.message.audio.file_id;
    const filePath = await downloadAudioFile(fileId);
    
    await ctx.reply('🔄 Розпізнаю текст...');
    const transcribedText = await transcribeAudio(filePath);
    
    await ctx.reply(`📝 Розпізнаний текст: "${transcribedText}"`);
    
    await ctx.reply('💰 Аналізую витрати...');
    const analysisResult = analyzeExpense(transcribedText);
    
    if (analysisResult.error) {
      await ctx.reply(`❌ ${analysisResult.error}`);
    } else {
      await sendExpenseConfirmation(
        ctx, 
        analysisResult.amount, 
        analysisResult.category, 
        transcribedText
      );
    }
    
    cleanupFiles([filePath]);
  } catch (err) {
    console.error('❌ Помилка при обробці голосового повідомлення:', err);
    await ctx.reply('❌ Виникла помилка при обробці голосового повідомлення');
  }
});

// Обробка текстових повідомлень
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return; 
  
  try {
    await ctx.reply('💰 Аналізую витрати...');
    const analysisResult = analyzeExpense(ctx.message.text);
    
    if (analysisResult.error) {
      await ctx.reply(`❌ ${analysisResult.error}`);
    } else {
      await sendExpenseConfirmation(
        ctx, 
        analysisResult.amount, 
        analysisResult.category, 
        ctx.message.text
      );
    }
  } catch (err) {
    console.error('❌ Помилка при обробці текстового повідомлення:', err);
    await ctx.reply('❌ Виникла помилка при обробці повідомлення');
  }
});

// Обробка підтвердження витрати
bot.action(/confirm_(.+)_(.+)_(.+)/, async (ctx) => {
  try {
    const amount = parseFloat(ctx.match[1]);
    const category = ctx.match[2];
    const noteId = ctx.match[3];
    const note = noteStorage[noteId];
    
    if (!note) {
      await ctx.reply('❌ Не вдалося знайти дані про витрату. Спробуйте знову.');
      return;
    }
    
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    await ctx.reply('⏳ Зберігаю дані...');
    
    const currentDate = new Date().toISOString();
    const success = await addExpenseToSheet(currentDate, amount, category, note);
    
    if (success) {
      await ctx.reply('✅ Дякую за використання бота! Ваші витрати успішно збережено.');
      delete noteStorage[noteId];
    } else {
      await ctx.reply('❌ Помилка при збереженні витрат. Спробуйте пізніше.');
    }
  } catch (err) {
    console.error('❌ Помилка при підтвердженні витрати:', err);
    await ctx.reply('❌ Помилка при збереженні витрати');
  }
});

// Обробка скасування
bot.action('cancel', async (ctx) => {
  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    await ctx.reply('❌ Витрату скасовано');
  } catch (err) {
    console.error('❌ Помилка при скасуванні:', err);
    await ctx.reply('❌ Помилка при скасуванні дії');
  }
});

// Обробка зміни категорії
bot.action(/change_category_(.+)_(.+)/, async (ctx) => {
  try {
    const amount = parseFloat(ctx.match[1]);
    const noteId = ctx.match[2];
    const note = noteStorage[noteId];
    
    if (!note) {
      await ctx.reply('❌ Не вдалося знайти дані про витрату. Спробуйте знову.');
      return;
    }
    
    const buttons = [];
    for (let i = 0; i < DEFAULT_CATEGORIES.length; i += 2) {
      const row = [];
      row.push(Markup.button.callback(DEFAULT_CATEGORIES[i], `set_category_${amount}_${DEFAULT_CATEGORIES[i]}_${noteId}`));
      
      if (i + 1 < DEFAULT_CATEGORIES.length) {
        row.push(Markup.button.callback(DEFAULT_CATEGORIES[i+1], `set_category_${amount}_${DEFAULT_CATEGORIES[i+1]}_${noteId}`));
      }
      
      buttons.push(row);
    }
    
    await ctx.editMessageReplyMarkup(Markup.inlineKeyboard(buttons));
  } catch (err) {
    console.error('❌ Помилка при зміні категорії:', err);
    await ctx.reply('❌ Помилка при зміні категорії');
  }
});

// Обробка встановлення категорії
bot.action(/set_category_(.+)_(.+)_(.+)/, async (ctx) => {
  try {
    const amount = parseFloat(ctx.match[1]);
    const category = ctx.match[2];
    const noteId = ctx.match[3];
    const note = noteStorage[noteId];
    
    if (!note) {
      await ctx.reply('❌ Не вдалося знайти дані про витрату. Спробуйте знову.');
      return;
    }
    
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    
    await sendExpenseConfirmation(ctx, amount, category, note);
  } catch (err) {
    console.error('❌ Помилка при виборі категорії:', err);
    await ctx.reply('❌ Помилка при виборі категорії');
  }
});

// Обробка запиту на зміну суми
bot.action(/change_amount_(.+)_(.+)_(.+)/, async (ctx) => {
  try {
    const currentAmount = parseFloat(ctx.match[1]);
    const category = ctx.match[2];
    const noteId = ctx.match[3];
    
    if (!noteStorage[noteId]) {
      await ctx.reply('❌ Не вдалося знайти дані про витрату. Спробуйте знову.');
      return;
    }
    
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    
    // Збереження даних у контексті сесії
    ctx.session = ctx.session || {};
    ctx.session.pendingAmount = {
      category,
      noteId
    };
    
    await ctx.reply(
      `💰 Поточна сума: ${currentAmount} грн\n` +
      `Будь ласка, введіть нову суму (тільки число):`,
      Markup.forceReply()
    );
  } catch (err) {
    console.error('❌ Помилка при запиті на зміну суми:', err);
    await ctx.reply('❌ Помилка при зміні суми');
  }
});

// Обробка початку роботи з ботом
bot.command('start', async (ctx) => {
  await ctx.reply(
    'Привіт! Я бот для аналізу витрат. 💰\n\n' +
    'Надішліть мені голосове повідомлення або текст з описом ваших витрат, і я визначу суму та категорію.\n\n' +
    'Наприклад: "Купив продукти на 450 гривень" або "Заплатив за комунальні 1200"'
  );
});

// Обробка команди допомоги
bot.command('help', async (ctx) => {
  await ctx.reply(
    '🤖 *Як користуватися ботом:*\n\n' +
    '1. Запишіть голосове повідомлення або надішліть текст з описом витрат\n' +
    '2. Я автоматично розпізнаю текст та аналізую витрати\n' +
    '3. Ви отримаєте повідомлення з підтвердженням\n' +
    '4. Підтвердіть витрату або змініть категорію чи суму\n' +
    '5. Після підтвердження дані будуть додані до Google таблиці\n\n' +
    '*Доступні категорії:*\n' +
    DEFAULT_CATEGORIES.map(cat => `• ${cat}`).join('\n'),
    { parse_mode: 'Markdown' }
  );
});

// Middleware для обробки відповідей для зміни суми
bot.use(async (ctx, next) => {
  // Пропускаємо не текстові повідомлення або повідомлення від бота
  if (!ctx.message || !ctx.message.text || ctx.message.from.is_bot) {
    return next();
  }
  
  // Перевіряємо, чи очікуємо відповідь на запит про зміну суми
  if (ctx.session && ctx.session.pendingAmount) {
    const { category, noteId } = ctx.session.pendingAmount;
    const note = noteStorage[noteId];
    
    if (!note) {
      await ctx.reply('❌ Сесія закінчилась. Спробуйте спочатку.');
      delete ctx.session.pendingAmount;
      return next();
    }
    
    // Валідація введеної суми
    const newAmount = parseFloat(ctx.message.text.replace(',', '.'));
    if (isNaN(newAmount) || newAmount <= 0) {
      await ctx.reply('❌ Будь ласка, введіть коректну суму (позитивне число)');
      return;
    }
    
    // Очищення даних сесії
    delete ctx.session.pendingAmount;
    
    // Відправка підтвердження з новою сумою
    await sendExpenseConfirmation(ctx, newAmount, category, note);
    return;
  }
  
  return next();
});

// Endpoint для перевірки стану бота
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'expense-tracker-bot',
    version: '1.0.0'
  });
});

// Endpoint для вебхуку
app.post('/webhook', (req, res) => {
  bot.handleUpdate(req.body, res);
});

// Функція запуску бота
const startBot = async () => {
  try {
    // Видалення попереднього вебхуку
    await bot.telegram.deleteWebhook();
    
    // Запуск бота в режимі вебхуку або polling
    if (process.env.USE_WEBHOOK && process.env.WEBHOOK_DOMAIN) {
      await bot.launch({
        webhook: {
          domain: process.env.WEBHOOK_DOMAIN,
          path: '/webhook'
        }
      });
      console.log('🤖 Telegram бот успішно запущено в режимі webhook');
    } else {
      await bot.launch();
      console.log('🤖 Telegram бот успішно запущено в режимі polling');
    }
  } catch (err) {
    console.error('❌ Помилка запуску бота:', err);
  }
};
bot.start(async (ctx) => {
  await ctx.reply(
    `👋 Привіт, ${ctx.message.from.first_name}!\n
Я — твій помічник у відстеженні витрат. Надішли мені текст або голосове повідомлення з покупкою, а я проаналізую витрати та допоможу їх записати у Google Таблицю.  
      
📌 Як користуватись:  
- Надішли **текст** або **голосове повідомлення** про покупку.  
- Я розпізнаю суму та категорію витрати.  
- Підтверди запис — і я збережу його в Google Sheets.  
      
🚀 Готовий розпочати? Надішли свою першу покупку!`
  );
});

// Запуск бота та сервера
startBot();

app.listen(PORT, () => {
  console.log(`🚀 Сервер працює на порту ${PORT}`);
});

// Обробка завершення роботи
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  console.log('🛑 Бот зупинено');
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  console.log('🛑 Бот зупинено');
});