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

// Get the base URL for the service from environment variable
const WEBHOOK_URL = process.env.WEBHOOK_URL;

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

// Clean up old analysis results every hour
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  
  for (const [key, value] of analysisResults.entries()) {
    const resultTime = new Date(value.date).getTime();
    if (resultTime < oneHourAgo) {
      analysisResults.delete(key);
    }
  }
  
  console.log(`Cleaned up analysis results. Current count: ${analysisResults.size}`);
}, 60 * 60 * 1000);

async function analyzeExpense(text) {
  try {
    const prompt = EXPENSE_PROMPT.replace('INPUT_TEXT', text);
    const result = await model.generateContent(prompt);
    const response = result.response.text().trim();

    const parseRegex = /(\d+(?:\.\d+)?)\s*,\s*([а-яіїєґА-ЯІЇЄҐ\s]+)/;
    const match = response.match(parseRegex);
    
    if (match && match.length >= 3) {
      // Extract currency from original text if available
      const currencyMatch = text.match(/грн|₴|\$|€|£/i);
      const currency = currencyMatch ? currencyMatch[0] : 'грн';
      
      return {
        amount: parseFloat(match[1]),
        currency: currency,
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
        // Extract currency from original text if available
        const currencyMatch = text.match(/грн|₴|\$|€|£/i);
        const currency = currencyMatch ? currencyMatch[0] : 'грн';
        
        return {
          amount: parsedResponse.amount,
          currency: currency,
          category: parsedResponse.category,
          originalText: text
        };
      }
    } catch (jsonError) {
      const amountMatch = response.match(/amount["\s:]+(\d+(?:\.\d+)?)/i);
      const categoryMatch = response.match(/category["\s:]+["']?([а-яіїєґА-ЯІЇЄҐ\s]+)["']?/i);
      
      if (amountMatch && categoryMatch) {
        // Extract currency from original text if available
        const currencyMatch = text.match(/грн|₴|\$|€|£/i);
        const currency = currencyMatch ? currencyMatch[0] : 'грн';
        
        return {
          amount: parseFloat(amountMatch[1]),
          currency: currency,
          category: categoryMatch[1].trim(),
          originalText: text
        };
      }
    }
    
    const numberMatch = text.match(/\d+(?:\.\d+)?/);
    // Extract currency from original text if available
    const currencyMatch = text.match(/грн|₴|\$|€|£/i);
    const currency = currencyMatch ? currencyMatch[0] : 'грн';
    
    return {
      amount: numberMatch ? parseFloat(numberMatch[0]) : null,
      currency: currency,
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

// Changed to use Whisper for transcription
async function transcribeAudioWithWhisper(audioPath) {
  try {
    // Using child_process to call Whisper CLI
    return new Promise((resolve, reject) => {
      const outputPath = audioPath.replace('.wav', '.txt');
      
      // For Render: Make sure Whisper is installed and available in the PATH
      exec(`whisper ${audioPath} --model small --language uk --output_format txt --output_dir ${TEMP_DIR}`, (error) => {
        if (error) {
          console.error('Whisper transcription error:', error);
          return reject(error);
        }
        
        try {
          const transcribedText = fs.readFileSync(outputPath, 'utf8');
          resolve(transcribedText.trim());
        } catch (readError) {
          reject(readError);
        }
      });
    });
  } catch (error) {
    console.error('Помилка транскрибування аудіо через Whisper:', error);
    return "Не вдалося розпізнати аудіо";
  }
}

function convertOggToWav(oggPath) {
  return new Promise((resolve, reject) => {
    const wavPath = oggPath.replace('.ogg', '.wav');
    
    // For Render: Make sure ffmpeg is installed
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
    // Process the data
    const result = await processRouterData(data);
    
    // Store the result in the analysisResults map
    const resultId = Date.now().toString();
    result.userId = data.userId;
    result.messageId = data.messageId;
    result.id = resultId;
    analysisResults.set(resultId, result);
    
    console.log('Analysis stored:', result);
    
    // Optionally send feedback to the user
    if (data.userId) {
      try {
        await bot.telegram.sendMessage(
          data.userId, 
          `✅ Витрату збережено:\n💰 ${result.amount} ${result.currency || 'грн'} - ${result.category}`
        );
      } catch (msgError) {
        console.error('Error sending confirmation message:', msgError);
      }
    }
    
    return result;
  } catch (error) {
    console.error('Error routing data to router:', error);
    throw error;
  }
}

// Function to process router data directly
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
        // Use Whisper for transcription
        const transcribedText = await transcribeAudioWithWhisper(wavPath);
        
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

// Function to process webhook data
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
      currency: result.currency || 'грн',
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

// Setup Express middleware before bot handlers
app.use(express.json({
  verify: (req, res, buf, encoding) => {
    req.rawBody = buf.toString(encoding || 'utf8');
  },
  strict: false  
}));

// Welcome message for new users
bot.start((ctx) => {
  ctx.reply(`👋 Привіт, ${ctx.message.from.first_name}!

Я бот для обліку витрат. Просто надішліть мені:
- текстове повідомлення (наприклад: "150 грн продукти")
- голосове повідомлення з описом витрати

Я автоматично розпізнаю суму та категорію і збережу вашу витрату.`);
});

// Help command with instructions
bot.help((ctx) => {
  ctx.reply(`ℹ️ Як користуватися ботом:

1️⃣ Відправте текстове повідомлення з сумою та описом покупки:
   Приклад: "500 грн канцтовари"

2️⃣ Або відправте голосове повідомлення з описом витрати
   Приклад: "Витратив 250 гривень на каву"

Бот автоматично визначить суму та категорію витрат і збереже інформацію.

Категорії:
✅ продукти
✅ кафе
✅ покупки
✅ ком послуги
✅ спорт
✅ канцтовари
✅ транспорт
✅ медицина
✅ розваги
✅ інші`);
});

// Optimized text handler
bot.on('text', async (ctx) => {
  try {
    const text = ctx.message.text;
    
    if (text.startsWith('/')) return;
    
    // Process and reply to the user
    const data = {
      type: 'TEXT',
      content: text,
      userId: ctx.message.from.id,
      messageId: ctx.message.message_id,
      timestamp: new Date().toISOString()
    };
    
    await routeToRouter(data);
    
  } catch (error) {
    console.error('Помилка при обробці повідомлення:', error);
    ctx.reply('❌ Виникла помилка при обробці вашого повідомлення. Спробуйте знову.');
  }
});

// Optimized voice/audio handler
bot.on(['voice', 'audio'], async (ctx) => {
  try {
    const fileId = ctx.message.voice ? ctx.message.voice.file_id : ctx.message.audio.file_id;
    
    // Acknowledge receipt of audio
    const processingMsg = await ctx.reply('🔄 Обробляю ваше аудіо...');
    
    // Download the audio file
    const oggPath = await downloadAudioFile(fileId);
    
    try {
      // Process audio
      const data = {
        type: 'AUDIO',
        filePath: oggPath,
        userId: ctx.message.from.id,
        messageId: ctx.message.message_id,
        timestamp: new Date().toISOString()
      };
      
      await routeToRouter(data);
      
      // Delete processing message
      await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {
        // Ignore errors on deleting message
      });
      
    } catch (audioError) {
      console.error('Помилка при обробці аудіо:', audioError);
      
      // Update message to error
      ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        '❌ Не вдалося розпізнати аудіо. Спробуйте відправити текстове повідомлення.'
      ).catch(() => {
        // Ignore errors on editing message
      });
      
      // Cleanup on error
      if (oggPath) cleanupFiles([oggPath]);
    }
  } catch (error) {
    console.error('Помилка при обробці аудіо повідомлення:', error);
    ctx.reply('❌ Виникла помилка при обробці вашого аудіо. Спробуйте знову або відправте текстове повідомлення.');
  }
});

// Add a command to get expense summary
bot.command('summary', async (ctx) => {
  try {
    const userId = ctx.message.from.id;
    
    // Get all expenses for this user
    const userExpenses = Array.from(analysisResults.values())
      .filter(result => result.userId === userId && !result.error);
    
    if (userExpenses.length === 0) {
      return ctx.reply('У вас ще немає збережених витрат.');
    }
    
    // Group by category
    const byCategory = {};
    let totalAmount = 0;
    
    userExpenses.forEach(expense => {
      const category = expense.category;
      const amount = expense.amount || 0;
      
      if (!byCategory[category]) {
        byCategory[category] = 0;
      }
      
      byCategory[category] += amount;
      totalAmount += amount;
    });
    
    // Create summary message
    let message = '📊 Підсумок ваших витрат:\n\n';
    
    Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1]) // Sort by amount descending
      .forEach(([category, amount]) => {
        const percentage = ((amount / totalAmount) * 100).toFixed(1);
        message += `${category}: ${amount} грн (${percentage}%)\n`;
      });
    
    message += `\n💰 Разом: ${totalAmount} грн`;
    
    ctx.reply(message);
  } catch (error) {
    console.error('Помилка при створенні звіту:', error);
    ctx.reply('❌ Не вдалося створити звіт. Спробуйте пізніше.');
  }
});

// Router endpoint for API compatibility
app.post('/router', async (req, res) => {
  try {
    const result = await processRouterData(req.body);
    res.json(result);
  } catch (error) {
    console.error('Error in router processing:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Webhook endpoint for HTTP requests
app.post('/webhook', async (req, res) => {
  try {
    const result = await processWebhookData(req.body);
    res.json(result);
  } catch (error) {
    console.error('Помилка обробки HTTP запиту:', error);
    res.status(500).json({ error: 'Внутрішня помилка сервера' });
  }
});

// API endpoints
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

// Root endpoint
app.get('/', (req, res) => {
  res.send('Бот працює!');
});

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Telegram webhook path
const webhookPath = '/telegram-webhook';

// Start the server first
const server = app.listen(PORT, () => {
  console.log(`Сервер працює на порту ${PORT}`);
  
  // After server is started, setup the bot
  if (WEBHOOK_URL) {
    // Setup webhook for Telegram bot
    bot.telegram.setWebhook(`${WEBHOOK_URL}${webhookPath}`)
      .then(() => {
        console.log(`Telegram вебхук встановлено на ${WEBHOOK_URL}${webhookPath}`);
        botRunning = true;
      })
      .catch(err => {
        console.error('Помилка встановлення вебхука:', err);
      });
      
    // Define webhook endpoint for Telegram
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
    
    console.log(`Бот працює в режимі вебхука на ${WEBHOOK_URL}${webhookPath}`);
  } else {
    // Use polling method if webhook URL is not provided
    bot.launch()
      .then(() => {
        console.log('Бот запущено в режимі polling!');
        botRunning = true;
      })
      .catch(err => {
        console.error('Помилка запуску бота:', err);
      });
  }
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