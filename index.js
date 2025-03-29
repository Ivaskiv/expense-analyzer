require('dotenv').config();
const { Telegraf } = require('telegraf');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

const EXPENSE_PROMPT = `проаналізуй ці витрати "INPUT_TEXT" і визнач суму та категорію.
Сума - це число без валюти.
Категорії: продукти, кафе, покупки, ком послуги, спорт, канцтовари, інші.
Якщо текст містить слова про зошити, ручки, олівці, папір - це категорія "канцтовари".
Поверни лише два значення через кому: суму (тільки число) та категорію. Наприклад: "500, канцтовари"`;

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
    
    // Use the analyzeExpense function directly instead of calling the AI again
    const result = await analyzeExpense(userText);
    
    if (result.error) {
      await ctx.reply(`Помилка: ${result.error}`);
    } else if (result.amount === null) {
      await ctx.reply('Не вдалося визначити суму витрат. Спробуйте вказати суму чіткіше.');
    } else {
      // Format a nice response
      await ctx.reply(`Записано витрати: ${result.amount} грн, категорія: ${result.category}`);
    }
  } catch (error) {
    console.error('Помилка:', error);
    await ctx.reply('Виникла помилка при аналізі витрат. Спробуйте ще раз.');
  }
});

async function analyzeExpense(text) {
  try {
    const prompt = EXPENSE_PROMPT.replace('INPUT_TEXT', text);
    const result = await model.generateContent(prompt);
    const response = result.response.text();
    
    // More robust parsing of the response
    // First, try to extract by comma
    let parts = response.split(',').map(part => part.trim());
    
    // If we don't have two parts, try to extract differently
    if (parts.length < 2) {
      // Try to extract first number in the text as amount
      const amountMatch = response.match(/\d+/);
      const amount = amountMatch ? parseFloat(amountMatch[0]) : null;
      
      // Look for category keywords
      const categoryMatches = {
        'продукти': 'продукти',
        'їжа': 'продукти',
        'кафе': 'кафе',
        'ресторан': 'кафе',
        'покупки': 'покупки',
        'ком': 'ком послуги',
        'комунальні': 'ком послуги',
        'спорт': 'спорт',
        'канцтовари': 'канцтовари',
        'зошит': 'канцтовари',
        'ручк': 'канцтовари',
        'папір': 'канцтовари'
      };
      
      let category = 'інші';
      for (const [keyword, cat] of Object.entries(categoryMatches)) {
        if (response.toLowerCase().includes(keyword.toLowerCase())) {
          category = cat;
          break;
        }
      }
      
      return {
        amount,
        category
      };
    }
    const amount = parseFloat(parts[0]);
    const category = parts[1];
    
    return {
      amount: isNaN(amount) ? null : amount,
      category: category
    };
  } catch (error) {
    console.error('Помилка аналізу витрат:', error);
    return { error: 'Помилка при аналізі витрат' };
  }
}

app.post('/webhook', async (req, res) => {
  try {
    let data = req.body;
    
    if (!data || !data.text) {
      return res.status(400).json({ error: 'Текст не знайдено у запиті' });
    }
    
    const expenseText = data.text;
    console.log('Отримано текст для аналізу:', expenseText);
    
    const result = await analyzeExpense(expenseText);
    
    res.json(result);
  } catch (error) {
    console.error('Помилка обробки HTTP запиту:', error);
    res.status(500).json({ error: 'Внутрішня помилка сервера' });
  }
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