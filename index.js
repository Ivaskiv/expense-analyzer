require('dotenv').config();
const { Telegraf } = require('telegraf');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

const EXPENSE_PROMPT = `проаналізуй ці витрати "INPUT_TEXT" в форматі"сума, категорія витрат", сума без вказання валюти - тільки число. В якості категорії витрат бери категорії (продукти, кафе, покупки, ком послуги, спорт, інші). Повертай лише суму і категорію, без пояснень`;

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

app.use(express.json({
  verify: (req, res, buf, encoding) => {
    req.rawBody = buf.toString(encoding || 'utf8');
  },
  strict: false  
}));

app.use((req, res, next) => {
  if (req.rawBody === undefined && req.method === 'POST') {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      req.rawBody = data;
      try {
        if (data && (data.startsWith('{') || data.startsWith('['))) {
          req.body = JSON.parse(data);
        }
      } catch (e) {
        console.log('Помилка парсингу JSON, але продовжуємо:', e.message);
      }
      next();
    });
  } else {
    next();
  }
});

bot.start((ctx) => {
  ctx.reply('Привіт! Надішли мені інформацію про витрати, я їх проаналізую.');
});

bot.on('text', async (ctx) => {
  try {
    const userText = ctx.message.text;
    if (userText.startsWith('/')) return;
    
    await ctx.replyWithChatAction('typing');
    
    const prompt = EXPENSE_PROMPT.replace('INPUT_TEXT', userText);
    const result = await model.generateContent(prompt);
    const response = result.response.text();
    
    await ctx.reply(response);
  } catch (error) {
    console.error('Помилка:', error);
    await ctx.reply('Виникла помилка при аналізі витрат. Спробуйте ще раз.');
  }
});

const webhookPath = '/webhook';

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
      console.log(`Вебхук встановлено на ${webhookUrl}${webhookPath}`);
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

app.get('/', (req, res) => {
  res.send('Бот працює!');
});

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