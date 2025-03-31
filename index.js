import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import { GoogleGenerativeAI } from '@google/generative-ai';
import express from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import util from 'util';

dotenv.config();

const execPromise = util.promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const EXPENSE_PROMPT = `проаналізуй ці витрати "INPUT_TEXT" і визнач суму та категорію.
Сума - це число без валюти.
Визнач найбільш підходящу категорію для цих витрат. Основні категорії: продукти, кафе, покупки, ком послуги, спорт, канцтовари, інші.
Поверни лише два значення через кому: суму (тільки число) та категорію. Наприклад: "500, канцтовари"`;

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

async function transcribeAudio(filePath) {
  try {
    const wavFilePath = filePath.replace('.ogg', '.wav');
    await execPromise(`ffmpeg -i ${filePath} ${wavFilePath}`);

    const { stdout } = await execPromise(`whisper ${wavFilePath} --language uk --model tiny`);
    
    const txtFilePath = wavFilePath.replace('.wav', '.txt');
    const transcription = fs.readFileSync(txtFilePath, 'utf8');
    
    fs.unlinkSync(wavFilePath);
    fs.unlinkSync(txtFilePath);
    
    return transcription;
  } catch (error) {
    console.error('Помилка при транскрибуванні аудіо:', error);
    
    if (error.message.includes('whisper: command not found')) {
      throw new Error('Whisper не встановлено. Будь ласка, встановіть Whisper для транскрипції аудіо.');
    }
    
    throw error;
  }
}

async function analyzeExpense(text) {
  try {
    const prompt = EXPENSE_PROMPT.replace('INPUT_TEXT', text);
    const result = await model.generateContent(prompt);
    const response = result.response.text(); 

    let parts = response.split(',').map(part => part.trim());

    if (parts.length < 2) {
      console.log('Неструктурована відповідь від AI:', response);
      
      const amountMatch = text.match(/\d+/);
      const amount = amountMatch ? parseFloat(amountMatch[0]) : null;
      
      const categoryPrompt = `З тексту "${text}" визнач лише категорію витрат. 
      Основні категорії: продукти, кафе, покупки, ком послуги, спорт, канцтовари, інші.
      Поверни тільки назву категорії.`;
      
      const categoryResult = await model.generateContent(categoryPrompt);
      const category = categoryResult.response.text().trim();

      return {
        amount,
        category,
        originalText: text
      };
    }

    const amount = parseFloat(parts[0]);
    const category = parts[1];

    return {
      amount: isNaN(amount) ? null : amount,
      category: category,
      originalText: text
    };
  } catch (error) {
    console.error('Помилка аналізу витрат:', error);
    return { error: 'Помилка при аналізі витрат', originalText: text };
  }
}

async function forwardDataToRouter(result, chatId = null) {
  try {
    const now = new Date();
    const formattedDate = now.toLocaleDateString('uk-UA', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric', 
      hour: '2-digit', 
      minute: '2-digit' 
    });
    
    const dataToForward = {
      date: formattedDate,
      amount: result.amount,
      category: result.category,
      originalText: result.originalText,
      chatId: chatId
    };
    
    if (process.env.FORWARD_URL) {
      try {
        const response = await axios.post(process.env.FORWARD_URL, dataToForward);
        console.log(`Дані успішно відправлено на ${process.env.FORWARD_URL}`);
        return { success: true, response: response.data };
      } catch (forwardError) {
        console.error('Помилка при відправці даних:', forwardError);
        return { success: false, error: forwardError.message };
      }
    } else {
      console.warn('FORWARD_URL не налаштовано. Дані не відправлено.');
      return { success: false, error: 'URL для пересилання не налаштовано' };
    }
  } catch (error) {
    console.error('Помилка при форматуванні/відправці даних:', error);
    return { success: false, error: error.message };
  }
}

bot.start((ctx) => ctx.reply('Привіт! Відправте мені текст або голосове повідомлення з інформацією про ваші витрати, і я допоможу їх обробити.'));
bot.help((ctx) => ctx.reply('Ви можете відправити текст (наприклад: "Купив продукти за 250 грн") або голосове повідомлення з описом витрат.'));

bot.on('text', async (ctx) => {
  try {
    const text = ctx.message.text;
    const chatId = ctx.message.chat.id;
    
    if (text.startsWith('/')) return;
    
    const processingMsg = await ctx.reply('Обробляю ваші витрати...');
    
    const result = await analyzeExpense(text);
    
    if (result.error) {
      return ctx.reply(`Помилка: ${result.error}`);
    }
    
    const forwardResult = await forwardDataToRouter(result, chatId);
    
    if (forwardResult.success) {
      await ctx.reply('Дані успішно збережено.');
    } else {
      await ctx.reply('Помилка при збереженні даних. Спробуйте ще раз пізніше.');
    }
    
    await ctx.telegram.deleteMessage(chatId, processingMsg.message_id);
  } catch (error) {
    console.error('Помилка при обробці текстового повідомлення:', error);
    ctx.reply('Виникла помилка при обробці вашого повідомлення. Будь ласка, спробуйте пізніше.');
  }
});

bot.on('voice', async (ctx) => {
  try {
    const chatId = ctx.message.chat.id;
    const processingMsg = await ctx.reply('Отримано голосове повідомлення. Обробляю...');
    
    const fileId = ctx.message.voice.file_id;
    const fileInfo = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    
    const response = await axios({
      method: 'GET',
      url: fileUrl,
      responseType: 'stream'
    });
    
    const filePath = path.join(tempDir, `${fileId}.ogg`);
    const writer = fs.createWriteStream(filePath);
    
    response.data.pipe(writer);
    
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    
    const transcription = await transcribeAudio(filePath);
    await ctx.reply(`Розпізнано: "${transcription}"`);
    
    const result = await analyzeExpense(transcription);
    
    if (result.error) {
      return ctx.reply(`Помилка: ${result.error}`);
    }
    
    const forwardResult = await forwardDataToRouter(result, chatId);
    
    if (forwardResult.success) {
      await ctx.reply('Дані успішно збережено.');
    } else {
      await ctx.reply('Помилка при збереженні даних. Спробуйте ще раз пізніше.');
    }
    
    await ctx.telegram.deleteMessage(chatId, processingMsg.message_id);
    
    fs.unlinkSync(filePath);
  } catch (error) {
    console.error('Помилка при обробці голосового повідомлення:', error);
    ctx.reply('Виникла помилка при обробці вашого голосового повідомлення. Будь ласка, спробуйте ще раз.');
  }
});

app.use(express.json({
  verify: (req, res, buf, encoding) => {
    req.rawBody = buf.toString(encoding || 'utf8');
  },
  strict: false  
}));

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
    const formattedDate = now.toLocaleDateString('uk-UA', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric', 
      hour: '2-digit', 
      minute: '2-digit' 
    });
    
    res.json({
      date: formattedDate,
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

app.get('/', (req, res) => {
  res.send('Бот працює!');
});

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

const server = app.listen(PORT, () => {
  console.log(`Сервер працює на порту ${PORT}`);
});

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