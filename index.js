import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';
import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

dotenv.config();

const PORT = process.env.PORT || 3000 || 3001;
const TEMP_DIR = path.join(dirname, 'temp');
const WIT_TOKEN = process.env.WIT_AI_TOKEN;

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const app = express();
app.use(express.json());

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const noteStorage = {};

const trainingData = JSON.parse(fs.readFileSync('training-data.json', 'utf8'));

async function trainWit() {
  if (!WIT_TOKEN) {
    console.log('⚠️ WIT_AI_TOKEN не налаштовано, пропускаємо навчання');
    return;
  }
  
  for (const data of trainingData) {
    await fetch(`https://api.wit.ai/entities`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WIT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });
  }
}

trainWit().then(() => {
  console.log('Навчання завершено');
}).catch(err => {
  console.error('Помилка при навчанні:', err);
});

const analyzeExpense = (text) => {
  try {
    const amountRegex = /(\d+(?:[.,]\d+)?)\s*(грн|гривень|грн\.|₴|uah|)/gi;
    const amountMatch = amountRegex.exec(text);
    
    let amount = 0;
    if (amountMatch) {
      amount = parseFloat(amountMatch[1].replace(',', '.'));
    } else {
      const numberMatch = /(\d+(?:[.,]\d+)?)/.exec(text);
      if (numberMatch) {
        amount = parseFloat(numberMatch[1].replace(',', '.'));
      }
    }
    
    let category = 'інші';
    
    const lowerText = text.toLowerCase();
    
    if (/прод[ау]кт|їж[аі]|хліб|молоко|овоч|фрукт/i.test(lowerText)) {
      category = 'продукти';
    } else if (/каф[еє]|ресторан|їдальн|обід|вечер[яю]|снідан[ок]/i.test(lowerText)) {
      category = 'кафе';
    } else if (/комунал|світло|газ|вод[аи]|опален|електро/i.test(lowerText)) {
      category = 'комунальні послуги';
    } else if (/спорт|трену|фітнес|абонемент|зал/i.test(lowerText)) {
      category = 'спорт';
    } else if (/зошит|ручк|олівц|папір|канц|книг/i.test(lowerText)) {
      category = 'канцтовари';
    } else if (/одяг|взутт|сороч|магазин|купив|купил|придба/i.test(lowerText)) {
      category = 'покупки';
    }
    
    return { amount, category };
  } catch (err) {
    console.error('Помилка аналізу витрат:', err);
    return { error: 'Помилка при аналізі витрат' };
  }
};

const setupGoogleSheets = async () => {
  try {
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

const addExpenseToSheet = async (date, amount, category, note) => {
  try {
    const doc = await setupGoogleSheets();
    const sheet = doc.sheetsByIndex[0]; 
    await sheet.addRow({
      'Дата': date,
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

const sendExpenseConfirmation = async (ctx, amount, category, note) => {
  const noteId = Date.now().toString();
  noteStorage[noteId] = note;
  
  await ctx.reply(
    `📊 *Результат аналізу:*\n` +
    `📝 Текст: ${note}\n` +
    `💰 Сума: ${amount}\n` +
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
          Markup.button.callback('🔄 Змінити категорію', `change_category_${amount}_${noteId}`)
        ]
      ])
    }
  );
};

const transcribeAudio = async (filePath) => {
  try {
    if (!process.env.WIT_AI_TOKEN) {
      console.log('⚠️ WIT_AI_TOKEN не налаштовано, повертаємо тестовий текст');
      return "800 гривень сорочка";
    }

    const formData = new FormData();
    formData.append('file', fs.createReadStream(filePath), {
      filename: path.basename(filePath),
      contentType: 'audio/ogg'
    });

    const response = await axios.post(
      'https://api.wit.ai/speech?v=20230215',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${process.env.WIT_AI_TOKEN}`,
          'Content-Type': 'multipart/form-data'
        }
      }
    );

    if (response.data && response.data.text) {
      return response.data.text;
    } else {
      throw new Error('Не вдалося отримати текст з Wit.ai');
    }
  } catch (err) {
    console.error('Помилка при транскрибації аудіо:', err);
    return "Не вдалося розпізнати аудіо. Спробуйте надіслати текстом.";
  }
};

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

const cleanupFiles = (filePaths) => {
  filePaths.forEach(filePath => {
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`Видалено файл: ${filePath}`);
      } catch (err) {
        console.error(`Помилка видалення файлу ${filePath}:`, err);
      }
    }
  });
};

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
    console.error('Помилка при обробці голосового повідомлення:', err);
    await ctx.reply('❌ Виникла помилка при обробці голосового повідомлення');
  }
});

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
    console.error('Помилка при обробці текстового повідомлення:', err);
    await ctx.reply('❌ Виникла помилка при обробці повідомлення');
  }
});

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
      await ctx.reply('❌ Помилка при збереженні витрат');
    }
  } catch (err) {
    console.error('Помилка при підтвердженні витрати:', err);
    await ctx.reply('❌ Помилка при збереженні витрати');
  }
});

bot.action('cancel', async (ctx) => {
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply('❌ Витрату скасовано');
});

bot.action(/change_category_(.+)_(.+)/, async (ctx) => {
  try {
    const amount = parseFloat(ctx.match[1]);
    const noteId = ctx.match[2];
    const note = noteStorage[noteId];
    
    if (!note) {
      await ctx.reply('❌ Не вдалося знайти дані про витрату. Спробуйте знову.');
      return;
    }
    
    const categories = ['продукти', 'кафе', 'покупки', 'комунальні послуги', 'спорт', 'канцтовари', 'інші'];
    
    const buttons = [];
    for (let i = 0; i < categories.length; i += 2) {
      const row = [];
      row.push(Markup.button.callback(categories[i], `set_category_${amount}_${categories[i]}_${noteId}`));
      
      if (i + 1 < categories.length) {
        row.push(Markup.button.callback(categories[i+1], `set_category_${amount}_${categories[i+1]}_${noteId}`));
      }
      
      buttons.push(row);
    }
    
    await ctx.editMessageReplyMarkup(Markup.inlineKeyboard(buttons));
  } catch (err) {
    console.error('Помилка при зміні категорії:', err);
    await ctx.reply('❌ Помилка при зміні категорії');
  }
});

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
    console.error('Помилка при виборі категорії:', err);
    await ctx.reply('❌ Помилка при виборі категорії');
  }
});

bot.command('start', async (ctx) => {
  await ctx.reply(
    'Привіт! Я бот для аналізу витрат. 💰\n\n' +
    'Надішліть мені голосове повідомлення або текст з описом ваших витрат, і я визначу суму та категорію.\n\n' +
    'Наприклад: "Купив продукти на 450 гривень" або "Заплатив за комунальні 1200"'
  );
});

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

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'expense-tracker-bot',
    version: '1.0.0'
  });
});

app.post('/webhook', (req, res) => {
  bot.handleUpdate(req.body, res);
});

const startBot = async () => {
  try {
    await bot.telegram.deleteWebhook();
    
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
    console.error('Помилка запуску бота:', err);
  }
};

startBot();

app.listen(PORT, () => {
  console.log(`🚀 Сервер працює на порту ${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));