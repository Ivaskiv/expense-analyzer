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

// For Render deployment, use the provided environment variable for the port
const PORT = process.env.PORT || 3000;

// Get the base URL for the service from environment variable or construct it
const BASE_URL = process.env.WEBHOOK_URL || `http://localhost:${PORT}`;

// Create temp directory for files
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const app = express();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

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

const analysisResults = new Map();

async function analyzeExpense(text) {
  try {
    const prompt = EXPENSE_PROMPT.replace('INPUT_TEXT', text);
    const result = await model.generateContent(prompt);
    const response = result.response.text().trim();

    const parseRegex = /(\d+(?:\.\d+)?)\s*,\s*([а-яіїєґА-ЯІЇЄҐ\s]+)/;
    const match = response.match(parseRegex);
    
    if (match && match.length >= 3) {
      return {
        amount: parseFloat(match[1]),
        category: match[2].trim(),
        originalText: text
      };
    }
    
    return await fallbackCategoryDetection(text);
  } catch (error) {
    console.error('Помилка аналізу витрат:', error);
    return { error: 'Помилка при аналізі витрат', originalText: text };
  }
}

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
      const parsedResponse = JSON.parse(response);
      if (parsedResponse.amount !== undefined && parsedResponse.category) {
        return {
          amount: parsedResponse.amount,
          category: parsedResponse.category,
          originalText: text
        };
      }
    } catch (jsonError) {
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

// Modified to use Google's Speech-to-Text API instead of Whisper
async function transcribeAudioWithGemini(audioPath) {
  try {
    // Read audio file as base64
    const audioBuffer = fs.readFileSync(audioPath);
    const base64Audio = audioBuffer.toString('base64');
    
    // Construct prompt for Gemini
    const prompt = "Transcribe the following audio. It is in Ukrainian language. Return only the transcribed text without any additional comments.";
    
    // Use Gemini model with audio input
    const result = await genAI.generateContent([
      prompt,
      { inlineData: { data: base64Audio, mimeType: "audio/wav" } }
    ]);
    
    return result.response.text().trim();
  } catch (error) {
    console.error('Помилка транскрибування аудіо через Gemini:', error);
    return "Не вдалося розпізнати аудіо";
  }
}

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

function cleanupFiles(filePaths) {
  filePaths.forEach(filePath => {
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error(`Помилка при видаленні файлу ${filePath}:`, err);
      }
    }
    
    // Check for additional related files
    const textFilePath = filePath.replace('.wav', '.txt');
    if (fs.existsSync(textFilePath)) {
      try {
        fs.unlinkSync(textFilePath);
      } catch (err) {
        console.error(`Помилка при видаленні файлу ${textFilePath}:`, err);
      }
    }
  });
}

// Function to route the data to the router using internal routing for Render
async function routeToRouter(data) {
  try {
    // For Render, we're using internal routing rather than making HTTP requests to ourselves
    return await processRouterData(data);
  } catch (error) {
    console.error('Error routing data to router:', error);
    throw error;
  }
}

// Function to process router data directly (without HTTP call)
async function processRouterData(data) {
  try {
    console.log('Router received data:', data);
    
    if (data.type === 'TEXT') {
      // Process text messages
      return await processWebhookData({ text: data.content });
    } else if (data.type === 'AUDIO') {
      // Process audio messages
      try {
        // First convert and transcribe
        const wavPath = await convertOggToWav(data.filePath);
        // Use Gemini for transcription instead of Whisper
        const transcribedText = await transcribeAudioWithGemini(wavPath);
        
        // Process the transcribed text
        const result = await processWebhookData({ text: transcribedText });
        
        // Cleanup files
        cleanupFiles([data.filePath, wavPath]);
        
        return result;
      } catch (audioError) {
        console.error('Error processing audio:', audioError);
        cleanupFiles([data.filePath]);
        return { error: 'Помилка при обробці аудіо', originalText: 'Audio processing failed' };
      }
    } else {
      throw new Error('Unknown data type');
    }
  } catch (error) {
    console.error('Error in router processing:', error);
    throw error;
  }
}

// Function to process webhook data directly (without HTTP call)
async function processWebhookData(data) {
  try {
    if (!data || !data.text) {
      throw new Error('Текст не знайдено у запиті');
    }

    const expenseText = data.text;
    console.log('Отримано текст для аналізу:', expenseText);

    const result = await analyzeExpense(expenseText);
    
    const now = new Date();
    return {
      date: now.toISOString(),
      amount: result.amount,
      category: result.category,
      originalText: result.originalText,
      error: result.error
    };
  } catch (error) {
    console.error('Помилка обробки даних:', error);
    throw error;
  }
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
let botRunning = false;

bot.start((ctx) => ctx.reply('Привіт! Відправте мені текст або аудіо з інформацією про ваші витрати, і я передам це в систему.'));
bot.help((ctx) => ctx.reply('Просто відправте мені текстове повідомлення або голосове повідомлення з описом витрат, наприклад: "Купив продукти за 250 грн"'));

bot.on('text', async (ctx) => {
  try {
    const text = ctx.message.text;
    
    if (text.startsWith('/')) return;
    
    // Instead of analyzing and replying, route the text data
    const data = {
      type: 'TEXT',
      content: text,
      userId: ctx.message.from.id,
      messageId: ctx.message.message_id,
      timestamp: new Date().toISOString()
    };
    
    // Route the data to the router component
    const result = await routeToRouter(data);
    
    // Reply to user with the result
    await ctx.reply(`Витрати успішно записані:\n${result.amount} грн - ${result.category}`);
    
  } catch (error) {
    console.error('Помилка при обробці повідомлення:', error);
    await ctx.reply('Виникла помилка при обробці вашого повідомлення. Спробуйте ще раз.');
  }
});

bot.on(['voice', 'audio'], async (ctx) => {
  try {
    await ctx.reply('Отримано аудіо, обробляю...');
    
    const fileId = ctx.message.voice ? ctx.message.voice.file_id : ctx.message.audio.file_id;
    
    // Download the audio file
    const oggPath = await downloadAudioFile(fileId);
    
    try {
      // Convert OGG to WAV
      const wavPath = await convertOggToWav(oggPath);
      
      // Use Gemini for transcription instead of Whisper
      const transcribedText = await transcribeAudioWithGemini(wavPath);
      
      if (!transcribedText || transcribedText === "Не вдалося розпізнати аудіо") {
        await ctx.reply('Не вдалося розпізнати аудіо. Спробуйте, будь ласка, відправити текстове повідомлення.');
        cleanupFiles([oggPath, wavPath]);
        return;
      }
      
      // Create a data object with the transcribed text
      const data = {
        type: 'TEXT',
        content: transcribedText, 
        userId: ctx.message.from.id,
        messageId: ctx.message.message_id,
        timestamp: new Date().toISOString()
      };
      
      // Route the data to the router component
      const result = await routeToRouter(data);
      
      // Reply to the user with the result
      await ctx.reply(`Текст: "${transcribedText}"\n\nВитрати успішно записані:\n${result.amount} грн - ${result.category}`);
      
      // Clean up temporary files
      cleanupFiles([oggPath, wavPath]);
    } catch (audioError) {
      console.error('Помилка при обробці аудіо:', audioError);
      await ctx.reply('Виникла помилка при обробці аудіо. Спробуйте відправити текстове повідомлення.');
      
      // Make sure to cleanup even on error
      if (oggPath) cleanupFiles([oggPath]);
    }
  } catch (error) {
    console.error('Помилка при обробці аудіо повідомлення:', error);
    await ctx.reply('Виникла помилка при обробці вашого аудіо. Спробуйте ще раз або відправте текстове повідомлення.');
  }
});

// Setup Express middleware
app.use(express.json({
  verify: (req, res, buf, encoding) => {
    req.rawBody = buf.toString(encoding || 'utf8');
  },
  strict: false  
}));

// Router endpoint - still keep HTTP endpoint for external systems
app.post('/router', async (req, res) => {
  try {
    const result = await processRouterData(req.body);
    res.json(result);
  } catch (error) {
    console.error('Error in router processing:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Webhook endpoint for HTTP requests - keep for API compatibility
app.post('/webhook', async (req, res) => {
  try {
    const result = await processWebhookData(req.body);
    res.json(result);
  } catch (error) {
    console.error('Помилка обробки HTTP запиту:', error);
    res.status(500).json({ error: 'Внутрішня помилка сервера' });
  }
});

app.get('/api/analysis/:resultId', (req, res) => {
  const { resultId } = req.params;
  
  if (analysisResults.has(resultId)) {
    res.json(analysisResults.get(resultId));
  } else {
    res.status(404).json({ error: 'Результат аналізу не знайдено' });
  }
});

app.get('/api/analysis/user/:userId', (req, res) => {
  const { userId } = req.params;
  
  const userResults = Array.from(analysisResults.values())
    .filter(result => result.userId === parseInt(userId));
  
  res.json(userResults);
});

app.get('/', (req, res) => {
  res.send('Бот працює!');
});

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

const webhookPath = '/telegram-webhook';

// Telegram webhook setup
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
      botRunning = true;
    })
    .catch(err => {
      console.error('Помилка встановлення вебхука:', err);
    });

  console.log(`Бот працює в режимі вебхука на ${webhookUrl}${webhookPath}`);
} else {
  bot.launch()
    .then(() => {
      console.log('Бот запущено в режимі polling!');
      botRunning = true;
    })
    .catch(err => {
      console.error('Помилка запуску бота:', err);
    });
}

const server = app.listen(PORT, () => {
  console.log(`Сервер працює на порту ${PORT}`);
});

// Handle graceful shutdown for Render
process.once('SIGINT', () => {
  server.close(() => {
    console.log('Сервер зупинено (SIGINT)');
    if (botRunning) {
      try {
        bot.stop('SIGINT');
      } catch (err) {
        console.log('Бот вже зупинено або не був запущений');
      }
    }
  });
});

process.once('SIGTERM', () => {
  server.close(() => {
    console.log('Сервер зупинено (SIGTERM)');
    if (botRunning) {
      try {
        bot.stop('SIGTERM');
      } catch (err) {
        console.log('Бот вже зупинено або не був запущений');
      }
    }
  });
});