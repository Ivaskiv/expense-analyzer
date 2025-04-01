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

// Basic setup and initialization
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const TEMP_DIR = path.join(__dirname, 'temp');

// Create temp directory if it doesn't exist
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Setup database - using Map for in-memory storage
// In production, consider using a real database
const analysisResults = new Map();
let resultCounter = 1;

// Initialize express app
const app = express();
app.use(express.json({
  verify: (req, res, buf, encoding) => {
    req.rawBody = buf.toString(encoding || 'utf8');
  },
  strict: false
}));

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Prompt for expense analysis
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

/**
 * Analyze expense text using Gemini AI
 * @param {string} text - Text to analyze
 * @returns {Object} Analysis result
 */
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
    return { 
      error: 'Помилка при аналізі витрат', 
      originalText: text,
      amount: null,
      category: 'інші'
    };
  }
}

/**
 * Fallback method for expense analysis when primary method fails
 * @param {string} text - Text to analyze
 * @returns {Object} Analysis result
 */
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
      // Try regex parsing if JSON parsing fails
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
    
    // Last resort - extract any number from text and use "інші" category
    const numberMatch = text.match(/\d+(?:\.\d+)?/);
    return {
      amount: numberMatch ? parseFloat(numberMatch[0]) : null,
      category: 'інші',
      originalText: text
    };
  } catch (error) {
    console.error('Помилка резервного аналізу витрат:', error);
    return { 
      error: 'Помилка при аналізі витрат', 
      originalText: text,
      amount: null,
      category: 'інші'
    };
  }
}

/**
 * Download audio file from Telegram
 * @param {string} fileId - Telegram file ID
 * @returns {string} Path to downloaded file
 */
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

/**
 * Convert OGG audio to WAV format using ffmpeg
 * @param {string} oggPath - Path to OGG file
 * @returns {string} Path to WAV file
 */
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

/**
 * Transcribe audio using Whisper
 * @param {string} audioPath - Шлях до аудіо файлу
 * @returns {string} Транскрибований текст
 */
async function transcribeAudioWithWhisper(audioPath) {
  try {
    const outputPath = audioPath.replace('.wav', '.txt');
    const modelPath = path.join(__dirname, 'models', 'whisper-medium-uk');
    
    return new Promise((resolve, reject) => {
      // Використовуємо medium модель для кращої якості з україномовними фразами
      // Додаємо спеціальні параметри для української мови
      exec(`whisper ${audioPath} --model medium --language uk --initial_prompt "Це аудіозапис українською про фінансові витрати" --output_format txt --output_dir ${TEMP_DIR} --task transcribe --beam_size 5 --best_of 5`, (error) => {
        if (error) {
          console.error('Помилка транскрипції Whisper:', error);
          return reject(error);
        }
        
        try {
          if (fs.existsSync(outputPath)) {
            let transcribedText = fs.readFileSync(outputPath, 'utf8').trim();
            
            // Постобробка для покращення розпізнавання сум і фінансової термінології
            transcribedText = improveFinancialTextRecognition(transcribedText);
            
            resolve(transcribedText);
          } else {
            // Перевіряємо альтернативний шлях виводу на основі конвенцій іменування Whisper
            const baseName = path.basename(audioPath, path.extname(audioPath));
            const alternativeOutputPath = path.join(TEMP_DIR, `${baseName}.txt`);
            
            if (fs.existsSync(alternativeOutputPath)) {
              let transcribedText = fs.readFileSync(alternativeOutputPath, 'utf8').trim();
              
              // Постобробка для покращення розпізнавання сум і фінансової термінології
              transcribedText = improveFinancialTextRecognition(transcribedText);
              
              resolve(transcribedText);
            } else {
              reject(new Error('Файл транскрипції не знайдено'));
            }
          }
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

/**
 * Покращення розпізнавання фінансових термінів у транскрибованому тексті
 * @param {string} text - Транскрибований текст
 * @returns {string} Покращений текст
 */
function improveFinancialTextRecognition(text) {
  // Виправлення типових помилок розпізнавання чисел
  let improved = text
    // Нормалізація чисел зі словами
    .replace(/(\d+)\s*(грн|гривень|грн\.|гривні)/gi, '$1 грн')
    .replace(/(\d+)\s*(грн|гривень|грн\.|гривні)(\s*\d+)/gi, '$1.$3 грн')
    // Виправлення для категорій витрат
    .replace(/продукт(и|ів|ам)/gi, 'продукти')
    .replace(/комунальн(і|их|им)/gi, 'ком послуги')
    .replace(/в магазин(і|у|ах)/gi, 'продукти')
    // Виправлення для сум з комою та крапкою
    .replace(/(\d+)[,\.](\d+)/g, (match, p1, p2) => `${p1}.${p2}`);
  
  // Пошук і нормалізація сум грошей
  const moneyPattern = /(\d+)\s*(?:гривень|грн|грн\.|гривні|грошей|гр\.)/gi;
  improved = improved.replace(moneyPattern, (match, amount) => `${amount} грн`);
  
  // Видалення зайвих пробілів
  improved = improved.replace(/\s+/g, ' ').trim();
  
  return improved;
}/**
 * Clean up temporary files
 * @param {Array<string>} filePaths - Paths to files to delete
 */
function cleanupFiles(filePaths) {
  filePaths.forEach(filePath => {
    if (!filePath) return;
    
    // Clean up related files with different extensions
    const basePath = filePath.substring(0, filePath.lastIndexOf('.'));
    const extensions = ['.ogg', '.wav', '.txt', '.json'];
    
    extensions.forEach(ext => {
      const fileToDelete = `${basePath}${ext}`;
      if (fs.existsSync(fileToDelete)) {
        try {
          fs.unlinkSync(fileToDelete);
        } catch (err) {
          console.error(`Помилка при видаленні файлу ${fileToDelete}:`, err);
        }
      }
    });
  });
}

/**
 * Process router data
 * @param {Object} data - Data to process
 * @returns {Object} Processing result
 */
async function processRouterData(data) {
  try {
    console.log('Router received data:', data);
    
    if (data.type === 'TEXT') {
      // Process text messages
      return await processWebhookData({ text: data.content, userId: data.userId });
    } else if (data.type === 'AUDIO') {
      // Process audio messages
      try {
        // First convert and transcribe
        const wavPath = await convertOggToWav(data.filePath);
        // Use Whisper for transcription
        const transcribedText = await transcribeAudioWithWhisper(wavPath);
        
        console.log('Transcribed text:', transcribedText);
        
        // Process the transcribed text
        const result = await processWebhookData({ 
          text: transcribedText, 
          userId: data.userId,
          source: 'audio' 
        });
        
        // Cleanup files
        cleanupFiles([data.filePath]);
        
        return result;
      } catch (audioError) {
        console.error('Error processing audio:', audioError);
        cleanupFiles([data.filePath]);
        return { 
          error: 'Помилка при обробці аудіо', 
          originalText: 'Audio processing failed',
          amount: null,
          category: 'інші'
        };
      }
    } else {
      throw new Error('Unknown data type');
    }
  } catch (error) {
    console.error('Error in router processing:', error);
    throw error;
  }
}

/**
 * Process webhook data
 * @param {Object} data - Data to process
 * @returns {Object} Processing result
 */
async function processWebhookData(data) {
  try {
    if (!data || !data.text) {
      throw new Error('Текст не знайдено у запиті');
    }

    const expenseText = data.text;
    console.log('Отримано текст для аналізу:', expenseText);

    const result = await analyzeExpense(expenseText);
    
    const now = new Date();
    const analysisResult = {
      resultId: resultCounter++,
      date: now.toISOString(),
      amount: result.amount,
      category: result.category,
      originalText: result.originalText,
      error: result.error,
      userId: data.userId || 'unknown',
      source: data.source || 'text'
    };
    
    // Store the result in our in-memory database
    analysisResults.set(analysisResult.resultId.toString(), analysisResult);
    
    // If analysisResults gets too large, remove old entries
    if (analysisResults.size > 1000) {
      const oldestKey = analysisResults.keys().next().value;
      analysisResults.delete(oldestKey);
    }
    
    return analysisResult;
  } catch (error) {
    console.error('Помилка обробки даних:', error);
    throw error;
  }
}

// Initialize Telegram bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
let botRunning = false;

// Bot handlers
bot.start((ctx) => {
  ctx.reply('Привіт! Я бот для аналізу витрат. Просто надішли мені текст або аудіо з описом твоїх витрат, і я проаналізую їх.');
});

bot.help((ctx) => {
  ctx.reply(`
Як користуватися ботом:
1. Відправ мені текстове повідомлення з описом витрат, наприклад: "Купив хліб за 35 грн".
2. Або запиши голосове повідомлення з описом витрат.
3. Я проаналізую твої витрати і додам їх до твоєї таблиці.

Підтримувані категорії витрат:
- продукти
- кафе
- покупки
- ком послуги
- спорт
- канцтовари
- транспорт
- медицина
- розваги
- інші
  `);
});

// Text handler
bot.on('text', async (ctx) => {
  try {
    const text = ctx.message.text;
    
    if (text.startsWith('/')) return;
    
    // Process text message
    const data = {
      type: 'TEXT',
      content: text,
      userId: ctx.message.from.id,
      messageId: ctx.message.message_id,
      timestamp: new Date().toISOString()
    };
    
    // Process the data without waiting for completion
    routeToRouter(data)
      .then(() => {
        ctx.reply('✅ Дані успішно оброблено');
      })
      .catch(error => {
        console.error('Помилка обробки текстового повідомлення:', error);
        ctx.reply('❌ Виникла помилка при обробці даних');
      });
    
  } catch (error) {
    console.error('Помилка при обробці повідомлення:', error);
    ctx.reply('❌ Виникла помилка при обробці повідомлення');
  }
});

// Voice/audio handler
bot.on(['voice', 'audio'], async (ctx) => {
  try {
    ctx.reply('🎤 Отримано аудіо, обробляю...');
    
    const fileId = ctx.message.voice ? ctx.message.voice.file_id : ctx.message.audio.file_id;
    
    // Download the audio file
    const oggPath = await downloadAudioFile(fileId);
    
    try {
      // Process audio message
      const data = {
        type: 'AUDIO',
        filePath: oggPath,
        userId: ctx.message.from.id,
        messageId: ctx.message.message_id,
        timestamp: new Date().toISOString()
      };
      
      // Process the data without waiting for completion
      routeToRouter(data)
        .then(() => {
          ctx.reply('✅ Аудіо успішно оброблено');
        })
        .catch(error => {
          console.error('Помилка обробки аудіо повідомлення:', error);
          ctx.reply('❌ Виникла помилка при обробці аудіо');
        });
      
    } catch (audioError) {
      console.error('Помилка при обробці аудіо:', audioError);
      ctx.reply('❌ Виникла помилка при обробці аудіо');
      
      // Cleanup on error
      if (oggPath) cleanupFiles([oggPath]);
    }
  } catch (error) {
    console.error('Помилка при обробці аудіо повідомлення:', error);
    ctx.reply('❌ Виникла помилка при обробці аудіо повідомлення');
  }
});

/**
 * Route data to router
 * @param {Object} data - Data to route
 * @returns {Promise<Object>} Router result
 */
async function routeToRouter(data) {
  try {
    // For Render, we're using internal routing
    return await processRouterData(data);
  } catch (error) {
    console.error('Error routing data to router:', error);
    throw error;
  }
}

// API endpoints
app.post('/router', async (req, res) => {
  try {
    const result = await processRouterData(req.body);
    res.json(result);
  } catch (error) {
    console.error('Error in router processing:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

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

// Root and health check endpoints
app.get('/', (req, res) => {
  res.send('Бот працює! Все ок!');
});

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

// Handle graceful shutdown
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