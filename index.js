import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import { GoogleGenerativeAI } from '@google/generative-ai';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Initialize Express server
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Google AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Define the improved prompt for expense analysis
const EXPENSE_PROMPT = `Проаналізуй витрати: "INPUT_TEXT"
Визнач суму (тільки число без валюти) та категорію витрат.
Категорії витрат:
- продукти: їжа, супермаркет, магазин, овочі, фрукти
- кафе: ресторан, кава, обід, вечеря, бар
- покупки: одяг, взуття, книги, подарунки
- ком послуги: комунальні, електрика, вода, газ, інтернет
- спорт: тренування, басейн, спортзал, інвентар
- канцтовари: зошити, ручки, олівці, папір
- транспорт: таксі, автобус, метро, бензин
- медицина: ліки, аптека, лікар
- розваги: кіно, театр, концерт
- інші: все, що не підходить до вищезазначених категорій

Формат відповіді: сума, категорія
Приклад: "500, канцтовари"`;

// Function to analyze expense text using AI
async function analyzeExpense(text) {
  try {
    const prompt = EXPENSE_PROMPT.replace('INPUT_TEXT', text);
    const result = await model.generateContent(prompt);
    const response = result.response.text().trim();

    // Use a better regex to extract amount and category
    const parseRegex = /(\d+(?:\.\d+)?)\s*,\s*([а-яіїєґА-ЯІЇЄҐ\s]+)/;
    const match = response.match(parseRegex);
    
    if (match && match.length >= 3) {
      return {
        amount: parseFloat(match[1]),
        category: match[2].trim(),
        originalText: text
      };
    }
    
    // If standard format failed, attempt to extract with enhanced AI prompt
    return await fallbackCategoryDetection(text);
  } catch (error) {
    console.error('Помилка аналізу витрат:', error);
    return { error: 'Помилка при аналізі витрат', originalText: text };
  }
}

// Fallback method for when direct parsing fails
async function fallbackCategoryDetection(text) {
  try {
    const enhancedPrompt = `Текст про витрати: "${text}"
    
Потрібно окремо визначити:
1. Суму (тільки число, без валюти)
2. Категорію витрат з наступних: продукти, кафе, покупки, ком послуги, спорт, канцтовари, транспорт, медицина, розваги, інші

Формат відповіді - JSON:
{
  "amount": число,
  "category": "категорія"
}`;

    const result = await model.generateContent(enhancedPrompt);
    const response = result.response.text();
    
    try {
      // Try to parse as JSON
      const parsedResponse = JSON.parse(response);
      if (parsedResponse.amount !== undefined && parsedResponse.category) {
        return {
          amount: parsedResponse.amount,
          category: parsedResponse.category,
          originalText: text
        };
      }
    } catch (jsonError) {
      // If JSON parsing fails, try to extract values using regex
      const amountMatch = response.match(/amount["\s:]+(\d+(?:\.\d+)?)/i);
      const categoryMatch = response.match(/category["\s:]+["']?([а-яіїєґА-ЯІЇЄҐ\s]+)["']?/i);
      
      if (amountMatch && categoryMatch) {
        return {
          amount: parseFloat(amountMatch[1]),
          category: categoryMatch[1].trim(),
          originalText: text
        };
      }
    }
    
    // Extract any numbers and use default category as last resort
    const numberMatch = text.match(/\d+(?:\.\d+)?/);
    return {
      amount: numberMatch ? parseFloat(numberMatch[0]) : null,
      category: 'інші',
      originalText: text
    };
  } catch (error) {
    console.error('Помилка резервного аналізу витрат:', error);
    return { error: 'Помилка при аналізі витрат', originalText: text };
  }
}

// Function to download audio file from Telegram
async function downloadAudioFile(fileId) {
  try {
    const fileInfo = await bot.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    
    const fileName = `${Date.now()}.ogg`;
    const filePath = path.join(TEMP_DIR, fileName);
    
    const response = await axios({
      method: 'GET',
      url: fileUrl,
      responseType: 'stream'
    });
    
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(filePath));
      writer.on('error', reject);
    });
  } catch (error) {
    console.error('Помилка завантаження аудіо файлу:', error);
    throw error;
  }
}

// Function to convert OGG to WAV
function convertOggToWav(oggPath) {
  return new Promise((resolve, reject) => {
    const wavPath = oggPath.replace('.ogg', '.wav');
    
    exec(`ffmpeg -i ${oggPath} -ar 16000 -ac 1 -c:a pcm_s16le ${wavPath}`, (error) => {
      if (error) {
        console.error('Помилка конвертації аудіо:', error);
        return reject(error);
      }
      resolve(wavPath);
    });
  });
}

// Function to transcribe audio using Whisper
function transcribeAudio(audioPath) {
  return new Promise((resolve, reject) => {
    exec(`whisper ${audioPath} --model tiny --language uk --output_format txt`, (error, stdout, stderr) => {
      if (error) {
        console.error('Помилка транскрибування аудіо:', error);
        return reject(error);
      }
      
      const textFilePath = audioPath.replace('.wav', '.txt');
      
      if (fs.existsSync(textFilePath)) {
        const transcribedText = fs.readFileSync(textFilePath, 'utf8').trim();
        resolve(transcribedText);
      } else {
        reject(new Error('Файл транскрипції не створено'));
      }
    });
  });
}

// Clean up temporary files
function cleanupFiles(filePaths) {
  filePaths.forEach(filePath => {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    const textFilePath = filePath.replace('.wav', '.txt');
    if (fs.existsSync(textFilePath)) {
      fs.unlinkSync(textFilePath);
    }
  });
}

// Initialize Telegram bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Set up bot commands
bot.start((ctx) => ctx.reply('Привіт! Відправте мені текст або аудіо з інформацією про ваші витрати, і я допоможу їх проаналізувати.'));
bot.help((ctx) => ctx.reply('Просто відправте мені текстове повідомлення або голосове повідомлення з описом витрат, наприклад: "Купив продукти за 250 грн"'));

// Handle text messages
bot.on('text', async (ctx) => {
  try {
    const text = ctx.message.text;
    
    // Skip commands
    if (text.startsWith('/')) return;
    
    ctx.reply('Аналізую ваші витрати...');
    
    const result = await analyzeExpense(text);
    
    if (result.error) {
      return ctx.reply(`Помилка: ${result.error}`);
    }
    
    ctx.reply(`✅ Витрати проаналізовано:\nСума: ${result.amount}\nКатегорія: ${result.category}`);
  } catch (error) {
    console.error('Помилка при обробці повідомлення:', error);
    ctx.reply('Виникла помилка при обробці вашого повідомлення. Будь ласка, спробуйте пізніше.');
  }
});

// Handle voice/audio messages
bot.on(['voice', 'audio'], async (ctx) => {
  try {
    const fileId = ctx.message.voice ? ctx.message.voice.file_id : ctx.message.audio.file_id;
    
    ctx.reply('Отримую аудіо повідомлення...');
    
    const oggPath = await downloadAudioFile(fileId);
    ctx.reply('Конвертую аудіо...');
    
    const wavPath = await convertOggToWav(oggPath);
    ctx.reply('Транскрибую аудіо...');
    
    const transcribedText = await transcribeAudio(wavPath);
    ctx.reply(`Розпізнаний текст: "${transcribedText}"`);
    
    ctx.reply('Аналізую витрати з аудіо...');
    const result = await analyzeExpense(transcribedText);
    
    cleanupFiles([oggPath, wavPath]);
    
    if (result.error) {
      return ctx.reply(`Помилка: ${result.error}`);
    }
    
    ctx.reply(`✅ Витрати проаналізовано:\nСума: ${result.amount}\nКатегорія: ${result.category}`);
  } catch (error) {
    console.error('Помилка при обробці аудіо повідомлення:', error);
    ctx.reply('Виникла помилка при обробці аудіо повідомлення. Будь ласка, спробуйте пізніше.');
  }
});

// Setup Express middleware
app.use(express.json({
  verify: (req, res, buf, encoding) => {
    req.rawBody = buf.toString(encoding || 'utf8');
  },
  strict: false  
}));

// Webhook route for expense analysis
app.post('/webhook', async (req, res) => {
  try {
    let data = req.body;

    if (!data || !data.text) {
      return res.status(400).json({ error: 'Текст не знайдено у запиті' });
    }

    const expenseText = data.text;
    console.log('Отримано текст для аналізу:', expenseText);

    const result = await analyzeExpense(expenseText);
    
    const now = new Date();
    res.json({
      date: now.toISOString(),
      amount: result.amount,
      category: result.category,
      originalText: result.originalText,
      error: result.error
    });
  } catch (error) {
    console.error('Помилка обробки HTTP запиту:', error);
    res.status(500).json({ error: 'Внутрішня помилка сервера' });
  }
});

// Health check route
app.get('/', (req, res) => {
  res.send('Бот працює!');
});

// Telegram webhook configuration
const webhookPath = '/telegram-webhook';

if (process.env.WEBHOOK_URL) {
  const webhookUrl = process.env.WEBHOOK_URL;

  app.post(webhookPath, (req, res) => {
    try {
      if (req.body) {
        bot.handleUpdate(req.body, res);
      } else if (req.rawBody) {
        try {
          const update = JSON.parse(req.rawBody);
          bot.handleUpdate(update, res);
        } catch (e) {
          console.error('Помилка парсингу тіла вебхука:', e);
          res.status(400).send('Невалідний JSON');
        }
      } else {
        console.error('Порожнє тіло запиту');
        res.status(400).send('Порожнє тіло запиту');
      }
    } catch (error) {
      console.error('Помилка при обробці вебхука:', error);
      res.status(500).send('Внутрішня помилка сервера');
    }
  });

  bot.telegram.setWebhook(`${webhookUrl}${webhookPath}`)
    .then(() => {
      console.log(`Telegram вебхук встановлено на ${webhookUrl}${webhookPath}`);
    })
    .catch(err => {
      console.error('Помилка встановлення вебхука:', err);
    });

  console.log(`Бот працює в режимі вебхука на ${webhookUrl}${webhookPath}`);
} else {
  bot.launch()
    .then(() => {
      console.log('Бот запущено в режимі polling!');
    })
    .catch(err => {
      console.error('Помилка запуску бота:', err);
    });
}

// Start the server
const server = app.listen(PORT, () => {
  console.log(`Сервер працює на порту ${PORT}`);
});

// Graceful shutdown
process.once('SIGINT', () => {
  server.close(() => {
    console.log('Сервер зупинено (SIGINT)');
    if (bot.botInfo) bot.stop('SIGINT');
  });
});

process.once('SIGTERM', () => {
  server.close(() => {
    console.log('Сервер зупинено (SIGTERM)');
    if (bot.botInfo) bot.stop('SIGTERM');
  });
});